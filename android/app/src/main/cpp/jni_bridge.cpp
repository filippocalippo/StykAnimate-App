#include <jni.h>

#include <cstdint>
#include <string>

#include "native_container.h"
#include "styk_core.h"

extern "C" {

JNIEXPORT jstring JNICALL
Java_com_layouter787_stykport_NativeCore_version(JNIEnv* env, jobject /*thiz*/) {
  return env->NewStringUTF(styk::core_version());
}

JNIEXPORT jstring JNICALL
Java_com_layouter787_stykport_NativeCore_abi(JNIEnv* env, jobject /*thiz*/) {
  return env->NewStringUTF(styk::core_abi());
}

// Decodes a .styk/.stkz/.stykmov file image and returns a text summary, or a
// line starting with "ERROR:" / "UNSUPPORTED:". Diagnostic entry point.
JNIEXPORT jstring JNICALL
Java_com_layouter787_stykport_NativeCore_probeNative(JNIEnv* env, jobject /*thiz*/, jbyteArray data) {
  if (data == nullptr) return env->NewStringUTF("ERROR: no data");
  const jsize length = env->GetArrayLength(data);
  jbyte* bytes = env->GetByteArrayElements(data, nullptr);
  if (bytes == nullptr) return env->NewStringUTF("ERROR: out of memory");
  const uint8_t* p = reinterpret_cast<const uint8_t*>(bytes);
  const size_t n = static_cast<size_t>(length);
  std::string text;
  styk::native::Kind kind;
  if (!styk::native::detect_kind(p, n, kind)) {
    text = "ERROR: not a StykAnimate project (.styk, .stkz or .stykmov)";
  } else {
    const styk::native::DecodeResult result = styk::native::decode(p, n, kind);
    if (result.ok) {
      text = styk::native::summarize(result);
    } else {
      text = (result.code == "codec_unavailable" ? "UNSUPPORTED: " : "ERROR: ") + result.error;
    }
  }
  env->ReleaseByteArrayElements(data, bytes, JNI_ABORT);
  return env->NewStringUTF(text.c_str());
}

}  // extern "C"
