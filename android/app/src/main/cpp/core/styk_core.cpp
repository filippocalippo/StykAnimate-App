#include "styk_core.h"

namespace styk {

const char* core_version() { return "0.0.1 (phase 0)"; }

const char* core_abi() {
#if defined(__aarch64__)
  return "arm64-v8a";
#elif defined(__arm__)
  return "armeabi-v7a";
#elif defined(__x86_64__)
  return "x86_64";
#elif defined(__i386__)
  return "x86";
#else
  return "unknown";
#endif
}

}  // namespace styk
