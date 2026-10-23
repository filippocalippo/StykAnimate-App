#include <jni.h>

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

}  // extern "C"
