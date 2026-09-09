// Fixed Windows Video-for-Windows subprocess bridge. No caller-supplied DLLs.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <vfw.h>
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <numeric>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
constexpr uint64_t maxPixels = 16ull * 1024 * 1024;
constexpr uint64_t maxFrame = 64ull * 1024 * 1024;
constexpr uint64_t maxOutput = 256ull * 1024 * 1024;
constexpr size_t maxState = 1024 * 1024;
constexpr unsigned archBits = sizeof(void*) * 8;
const char* architecture = sizeof(void*) == 8 ? "x64" : "x86";

struct Failure : std::runtime_error {
  std::string code;
  Failure(std::string codeValue, std::string message) : std::runtime_error(message), code(std::move(codeValue)) {}
};
std::string utf8(const std::wstring& text) {
  if (text.empty()) return {};
  const int size = WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
  std::string result(size, '\0');
  WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), result.data(), size, nullptr, nullptr);
  return result;
}
std::string json(const std::string& text) {
  std::ostringstream out; out << '"';
  const char* hex = "0123456789abcdef";
  for (unsigned char c : text) {
    if (c == '"' || c == '\\') out << '\\' << c;
    else if (c < 32) out << "\\u00" << hex[c >> 4] << hex[c & 15];
    else out << c;
  }
  out << '"'; return out.str();
}
std::string codeString(LONG_PTR code) {
  std::ostringstream out; out << "0x" << std::hex << static_cast<uint32_t>(code); return out.str();
}
void check(HRESULT result, const char* operation) {
  if (result != AVIERR_OK) throw Failure("VFW_API", std::string(operation) + " failed (" + codeString(result) + ").");
}
uint64_t number(const wchar_t* text, uint64_t maximum, const char* name) {
  std::wstring value(text); if (value.empty() || value.find_first_not_of(L"0123456789") != std::wstring::npos)
    throw Failure("ARGUMENT", std::string(name) + " must be an unsigned decimal integer.");
  size_t consumed = 0; uint64_t result = 0;
  try { result = std::stoull(value, &consumed, 10); } catch (...) { throw Failure("ARGUMENT", std::string(name) + " is out of range."); }
  if (consumed != value.size() || result > maximum) throw Failure("ARGUMENT", std::string(name) + " is out of range.");
  return result;
}
DWORD handlerNumber(const wchar_t* value) { return static_cast<DWORD>(number(value, UINT32_MAX, "handler")); }
std::string fourcc(DWORD value) {
  std::string result;
  for (int i = 0; i < 4; ++i) result += static_cast<char>((value >> (i * 8)) & 255);
  return result;
}
struct Format {
  BITMAPINFOHEADER header{};
  DWORD stride = 0;
  Format(const wchar_t* widthText, const wchar_t* heightText) {
    const uint64_t width = number(widthText, 16384, "width"), height = number(heightText, 16384, "height");
    const uint64_t row = (width * 3 + 3) & ~3ull;
    if (!width || !height || width * height > maxPixels || row * height > maxFrame)
      throw Failure("DIMENSIONS", "RGB24 input exceeds the supported canvas or frame size.");
    stride = static_cast<DWORD>(row); header.biSize = sizeof(header); header.biWidth = static_cast<LONG>(width);
    header.biHeight = static_cast<LONG>(height); header.biPlanes = 1; header.biBitCount = 24;
    header.biCompression = BI_RGB; header.biSizeImage = static_cast<DWORD>(row * height);
  }
};
struct Codec {
  HIC handle = nullptr;
  explicit Codec(DWORD code) : handle(ICOpen(ICTYPE_VIDEO, code, ICMODE_COMPRESS)) {}
  ~Codec() { if (handle) ICClose(handle); }
  Codec(const Codec&) = delete; Codec& operator=(const Codec&) = delete;
};
bool registered(DWORD handler) {
  for (DWORD index = 0; index < 4096; ++index) {
    ICINFO info{}; info.dwSize = sizeof(info);
    if (!ICInfo(ICTYPE_VIDEO, index, &info)) return false;
    if (info.fccHandler == handler) return true;
  }
  return false;
}
ICINFO codecInfo(HIC codec) {
  ICINFO info{}; info.dwSize = sizeof(info);
  if (!ICGetInfo(codec, &info, sizeof(info))) throw Failure("CODEC_INFO", "The installed compressor did not return its capabilities.");
  return info;
}
void requireCodec(DWORD handler, Codec& codec, const Format& format) {
  if (!handler || !registered(handler)) throw Failure("CODEC_ID", "The requested handler is not an installed video compressor.");
  if (!codec.handle) throw Failure("CODEC_OPEN", "The installed compressor could not be opened for encoding.");
  const LRESULT result = ICCompressQuery(codec.handle, &format.header, nullptr);
  if (result != ICERR_OK) throw Failure("CODEC_FORMAT", "The installed compressor rejects this bottom-up RGB24 canvas (" + codeString(result) + ").");
}
void list(const Format& format) {
  std::cout << "{\"schema\":1,\"architecture\":" << json(architecture)
            << ",\"inputFormat\":\"BGR24-bottom-up\",\"stride\":" << format.stride
            << ",\"frameBytes\":" << format.header.biSizeImage << ",\"codecs\":["
            << "{\"handler\":0,\"fourcc\":\"DIB \",\"kind\":\"uncompressed\",\"name\":\"Uncompressed RGB24\",\"description\":\"Full frames (uncompressed)\",\"supported\":true,\"reason\":\"\",\"flags\":0,\"quality\":false,\"configure\":false,\"keyframes\":false,\"dataRate\":false}";
  std::vector<DWORD> seen;
  for (DWORD index = 0; index < 4096; ++index) {
    ICINFO info{}; info.dwSize = sizeof(info);
    if (!ICInfo(ICTYPE_VIDEO, index, &info)) break;
    if (!info.fccHandler || std::find(seen.begin(), seen.end(), info.fccHandler) != seen.end()) continue;
    const DWORD registeredHandler = info.fccHandler;
    seen.push_back(registeredHandler); Codec codec(registeredHandler);
    bool supported = false, configure = false; std::string reason;
    if (codec.handle) {
      ICINFO opened{}; opened.dwSize = sizeof(opened);
      if (ICGetInfo(codec.handle, &opened, sizeof(opened))) info = opened;
      // Some registry aliases return their driver's canonical FourCC here.
      // Keep the identity that ICInfo enumerated and that ICOpen accepted.
      info.fccHandler = registeredHandler;
      const LRESULT query = ICCompressQuery(codec.handle, &format.header, nullptr);
      supported = query == ICERR_OK; configure = ICQueryConfigure(codec.handle);
      if (!supported) reason = "Compressor rejects bottom-up RGB24 at these dimensions (" + codeString(query) + ").";
    } else reason = "Installed driver could not be opened in compression mode.";
    std::cout << ",{\"handler\":" << info.fccHandler << ",\"fourcc\":" << json(fourcc(info.fccHandler))
      << ",\"kind\":\"installed\",\"name\":" << json(utf8(info.szName)) << ",\"description\":" << json(utf8(info.szDescription))
      << ",\"supported\":" << (supported ? "true" : "false") << ",\"reason\":" << json(reason) << ",\"flags\":" << info.dwFlags
      << ",\"quality\":" << ((info.dwFlags & VIDCF_QUALITY) ? "true" : "false") << ",\"configure\":" << (configure ? "true" : "false")
      << ",\"keyframes\":" << ((info.dwFlags & VIDCF_TEMPORAL) ? "true" : "false") << ",\"dataRate\":" << ((info.dwFlags & VIDCF_CRUNCH) ? "true" : "false") << '}';
  }
  std::cout << "]}" << std::endl;
}
struct StateHeader { char magic[8]; uint32_t bits, handler, size; };
static_assert(sizeof(StateHeader) == 20);
std::vector<unsigned char> readState(const std::filesystem::path& path, DWORD handler, bool optional = false) {
  if (!std::filesystem::exists(path)) {
    if (optional) return {};
    throw Failure("STATE_FILE", "The compressor settings file does not exist.");
  }
  const auto size = std::filesystem::file_size(path);
  if (size < sizeof(StateHeader) || size > maxState) throw Failure("STATE_SIZE", "The compressor settings file exceeds its bounded format.");
  std::ifstream file(path, std::ios::binary); StateHeader header{};
  file.read(reinterpret_cast<char*>(&header), sizeof(header));
  if (!file || std::memcmp(header.magic, "STYKVFW1", 8) || header.bits != archBits || header.handler != handler || header.size != size - sizeof(header))
    throw Failure("STATE_ID", "The compressor settings do not match this codec and architecture.");
  std::vector<unsigned char> state(header.size);
  file.read(reinterpret_cast<char*>(state.data()), static_cast<std::streamsize>(state.size()));
  if (!file) throw Failure("STATE_READ", "The compressor settings file is truncated.");
  return state;
}
void setState(HIC codec, const std::vector<unsigned char>& state) {
  if (state.empty()) return;
  const LRESULT result = ICSetState(codec, state.data(), state.size());
  if (result < 0) throw Failure("STATE_REJECTED", "The compressor rejected its saved settings (" + codeString(result) + ").");
}
void configure(DWORD handler, const Format& format, const wchar_t* ownerText, const std::filesystem::path& stateFile) {
  Codec codec(handler); requireCodec(handler, codec, format);
  const auto ownerValue = number(ownerText, std::numeric_limits<uintptr_t>::max(), "ownerHWND");
  HWND owner = reinterpret_cast<HWND>(static_cast<uintptr_t>(ownerValue));
  if (!owner || !IsWindow(owner)) throw Failure("OWNER_WINDOW", "Compressor configuration requires the owning application window.");
  if (!ICQueryConfigure(codec.handle)) throw Failure("NO_CONFIGURATION", "This installed compressor has no configuration dialog.");
  const auto previous = readState(stateFile, handler, true); setState(codec.handle, previous);
  const LRESULT configured = ICConfigure(codec.handle, owner);
  // Installed drivers also return positive dialog results (Cinepak returns 1
  // on Cancel). Only negative ICERR values indicate an API failure.
  if (configured < 0) throw Failure("CONFIGURE", "Compressor configuration failed (" + codeString(configured) + ").");
  const LRESULT requested = ICGetState(codec.handle, nullptr, 0);
  if (requested < 0 || static_cast<uint64_t>(requested) > maxState - sizeof(StateHeader))
    throw Failure("STATE_SIZE", "The compressor returned an unsupported settings size.");
  std::vector<unsigned char> state(static_cast<size_t>(requested));
  if (!state.empty()) {
    const LRESULT written = ICGetState(codec.handle, state.data(), state.size());
    if (written <= 0 || static_cast<size_t>(written) > state.size()) throw Failure("STATE_READ", "The compressor did not return its settings.");
    state.resize(static_cast<size_t>(written));
  }
  StateHeader header{}; std::memcpy(header.magic, "STYKVFW1", 8); header.bits = archBits; header.handler = handler; header.size = static_cast<uint32_t>(state.size());
  auto temporary = stateFile; temporary += L".pending";
  try {
    std::ofstream file(temporary, std::ios::binary | std::ios::trunc);
    file.write(reinterpret_cast<const char*>(&header), sizeof(header)); file.write(reinterpret_cast<const char*>(state.data()), static_cast<std::streamsize>(state.size()));
    file.close(); if (!file) throw Failure("STATE_WRITE", "Could not save compressor settings.");
    if (!MoveFileExW(temporary.c_str(), stateFile.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) throw Failure("STATE_WRITE", "Could not commit compressor settings.");
  } catch (...) { DeleteFileW(temporary.c_str()); throw; }
  std::cout << "{\"type\":\"configured\",\"handler\":" << handler << ",\"stateBytes\":" << state.size() << ",\"dialogResult\":" << configured << "}" << std::endl;
}
struct Output {
  std::filesystem::path path; bool complete = false;
  explicit Output(std::filesystem::path value) : path(std::move(value)) {
    HANDLE file = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) throw Failure("OUTPUT_FILE", "AVI output must be a new writable file (" + codeString(GetLastError()) + ").");
    CloseHandle(file);
  }
  ~Output() { if (!complete) DeleteFileW(path.c_str()); }
  uint64_t checkedSize() const {
    const uint64_t size = std::filesystem::file_size(path);
    if (size > maxOutput) throw Failure("OUTPUT_LIMIT", "The AVI exceeds the 256 MiB desktop export limit.");
    return size;
  }
};
struct Avi {
  PAVIFILE file = nullptr; PAVISTREAM raw = nullptr, compressed = nullptr;
  Avi() { AVIFileInit(); }
  void close() {
    if (compressed && compressed != raw) AVIStreamRelease(compressed);
    compressed = nullptr; if (raw) AVIStreamRelease(raw); raw = nullptr;
    if (file) AVIFileRelease(file); file = nullptr;
  }
  ~Avi() { close(); AVIFileExit(); }
};
void readFrame(std::vector<unsigned char>& bytes, LONG index) {
  size_t offset = 0;
  while (offset < bytes.size()) {
    DWORD got = 0;
    if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), bytes.data() + offset, static_cast<DWORD>(bytes.size() - offset), &got, nullptr) || !got)
      throw Failure("SHORT_INPUT", "Raw frame " + std::to_string(index) + " is missing or truncated.");
    offset += got;
  }
}
void encode(int argc, wchar_t** argv) {
  const std::filesystem::path outputPath(argv[2]); const DWORD handler = handlerNumber(argv[3]); const Format format(argv[4], argv[5]);
  DWORD numerator = static_cast<DWORD>(number(argv[6], UINT32_MAX, "fpsNumerator")), denominator = static_cast<DWORD>(number(argv[7], 1000000, "fpsDenominator"));
  const DWORD frames = static_cast<DWORD>(number(argv[8], 1000000, "totalFrames"));
  const DWORD quality = std::wstring(argv[9]) == L"-1" ? ICQUALITY_DEFAULT : static_cast<DWORD>(number(argv[9], 10000, "quality"));
  const DWORD keyframes = static_cast<DWORD>(number(argv[10], 1000000, "keyframeEvery")), dataRate = static_cast<DWORD>(number(argv[11], UINT32_MAX, "dataRateBytesPerSec"));
  if (!numerator || !denominator || !frames || numerator > static_cast<uint64_t>(denominator) * 1000)
    throw Failure("ARGUMENT", "Frame count and rational frame rate must be positive and supported.");
  const DWORD divisor = std::gcd(numerator, denominator); numerator /= divisor; denominator /= divisor;
  std::vector<unsigned char> state;
  if (argc == 13) state = readState(argv[12], handler);
  if (handler) {
    Codec codec(handler); requireCodec(handler, codec, format); setState(codec.handle, state);
    if (ICCompressQuery(codec.handle, &format.header, nullptr) != ICERR_OK) throw Failure("CODEC_FORMAT", "Saved compressor settings reject this RGB24 canvas.");
    const ICINFO info = codecInfo(codec.handle);
    if ((quality != ICQUALITY_DEFAULT && !(info.dwFlags & VIDCF_QUALITY)) || (keyframes && !(info.dwFlags & VIDCF_TEMPORAL)) || (dataRate && !(info.dwFlags & VIDCF_CRUNCH)))
      throw Failure("CODEC_OPTION", "The installed compressor does not support one of the requested quality, keyframe or data-rate controls.");
  } else if (!state.empty() || keyframes || dataRate || quality != ICQUALITY_DEFAULT) throw Failure("CODEC_OPTION", "Uncompressed AVI does not accept compressor options.");
  Output output(outputPath); Avi avi;
  check(AVIFileOpenW(&avi.file, outputPath.c_str(), OF_CREATE | OF_WRITE, nullptr), "AVIFileOpen");
  AVISTREAMINFOW stream{}; stream.fccType = streamtypeVIDEO; stream.dwScale = denominator; stream.dwRate = numerator;
  stream.dwSuggestedBufferSize = format.header.biSizeImage; stream.dwQuality = quality;
  SetRect(&stream.rcFrame, 0, 0, format.header.biWidth, format.header.biHeight);
  wcscpy_s(stream.szName, L"StykAnimate video");
  check(AVIFileCreateStreamW(avi.file, &avi.raw, &stream), "AVIFileCreateStream");
  if (handler) {
    AVICOMPRESSOPTIONS options{}; options.fccType = streamtypeVIDEO; options.fccHandler = handler; options.dwQuality = quality;
    options.dwFlags = AVICOMPRESSF_VALID;
    if (keyframes) { options.dwFlags |= AVICOMPRESSF_KEYFRAMES; options.dwKeyFrameEvery = keyframes; }
    if (dataRate) { options.dwFlags |= AVICOMPRESSF_DATARATE; options.dwBytesPerSecond = dataRate; }
    options.lpParms = state.empty() ? nullptr : state.data(); options.cbParms = static_cast<DWORD>(state.size());
    check(AVIMakeCompressedStream(&avi.compressed, avi.raw, &options, nullptr), "AVIMakeCompressedStream");
  } else avi.compressed = avi.raw;
  check(AVIStreamSetFormat(avi.compressed, 0, const_cast<BITMAPINFOHEADER*>(&format.header), sizeof(format.header)), "AVIStreamSetFormat");
  std::vector<unsigned char> bytes(format.header.biSizeImage);
  std::cout << "{\"type\":\"ready\",\"architecture\":" << json(architecture) << ",\"stride\":" << format.stride << ",\"frameBytes\":" << bytes.size() << "}" << std::endl;
  for (LONG index = 0; index < static_cast<LONG>(frames); ++index) {
    readFrame(bytes, index); LONG samplesWritten = 0, bytesWritten = 0;
    // Each input is an independent raw DIB. The compression stream chooses the
    // output keyframes using AVICOMPRESSOPTIONS and its installed compressor.
    check(AVIStreamWrite(avi.compressed, index, 1, bytes.data(), static_cast<LONG>(bytes.size()), AVIIF_KEYFRAME, &samplesWritten, &bytesWritten), "AVIStreamWrite");
    if (samplesWritten != 1) throw Failure("FRAME_WRITE", "The AVI stream did not accept exactly one input frame.");
    output.checkedSize();
    std::cout << "{\"type\":\"frame\",\"index\":" << index << ",\"bytesWritten\":" << bytesWritten << "}" << std::endl;
  }
  unsigned char extra = 0; DWORD got = 0;
  const BOOL ended = ReadFile(GetStdHandle(STD_INPUT_HANDLE), &extra, 1, &got, nullptr);
  if (got) throw Failure("EXTRA_INPUT", "The raw stream contains bytes beyond the declared frame count.");
  if (!ended && GetLastError() != ERROR_BROKEN_PIPE && GetLastError() != ERROR_HANDLE_EOF) throw Failure("INPUT_READ", "Could not verify the end of the raw frame stream.");
  avi.close(); const uint64_t size = output.checkedSize(); output.complete = true;
  std::cout << "{\"type\":\"complete\",\"frames\":" << frames << ",\"sizeBytes\":" << size << "}" << std::endl;
}
}

int wmain(int argc, wchar_t** argv) {
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
  SetDllDirectoryW(L"");
  try {
    if (argc == 4 && std::wstring(argv[1]) == L"--list") list(Format(argv[2], argv[3]));
    else if (argc == 7 && std::wstring(argv[1]) == L"--configure") configure(handlerNumber(argv[2]), Format(argv[3], argv[4]), argv[5], argv[6]);
    else if ((argc == 12 || argc == 13) && std::wstring(argv[1]) == L"--encode") encode(argc, argv);
    else throw Failure("ARGUMENT", "Use --list width height; --configure handler width height ownerHWND stateFile; or --encode output handler width height fpsNumerator fpsDenominator frames quality keyframeEvery dataRate [stateFile].");
    return 0;
  } catch (const Failure& error) {
    const std::string line = "{\"type\":\"error\",\"code\":" + json(error.code) + ",\"message\":" + json(error.what()) + "}";
    std::cout << line << std::endl; std::cerr << line << std::endl; return 1;
  } catch (const std::exception& error) {
    const std::string line = "{\"type\":\"error\",\"code\":\"INTERNAL\",\"message\":" + json(error.what()) + "}";
    std::cout << line << std::endl; std::cerr << line << std::endl; return 1;
  }
}
