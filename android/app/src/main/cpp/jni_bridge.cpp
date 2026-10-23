#include <jni.h>

#include <cstdint>
#include <string>

#include "piv.h"
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

// Decodes a .piv image and returns a text summary, or a line starting with
// "ERROR:" / "UNSUPPORTED:". Temporary diagnostic entry point for phase 1.
JNIEXPORT jstring JNICALL
Java_com_layouter787_stykport_NativeCore_probePiv(JNIEnv* env, jobject /*thiz*/, jbyteArray data) {
  if (data == nullptr) return env->NewStringUTF("ERROR: no data");
  const jsize length = env->GetArrayLength(data);
  jbyte* bytes = env->GetByteArrayElements(data, nullptr);
  if (bytes == nullptr) return env->NewStringUTF("ERROR: out of memory");
  const styk::piv::Result result =
      styk::piv::decode(reinterpret_cast<const uint8_t*>(bytes), static_cast<size_t>(length));
  env->ReleaseByteArrayElements(data, bytes, JNI_ABORT);
  std::string text;
  if (result.ok) {
    text = styk::piv::summarize(result.doc);
  } else {
    text = (result.unsupported ? "UNSUPPORTED: " : "ERROR: ") + result.error;
  }
  return env->NewStringUTF(text.c_str());
}

}  // extern "C"
