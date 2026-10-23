package com.layouter787.stykport

/**
 * Kotlin side of the JNI bridge to the C++ core (libstykcore.so).
 *
 * Phase 1 exposes diagnostics and a PIV probe. Later phases add document
 * handles, evaluation and rendering entry points here.
 */
object NativeCore {
    init {
        System.loadLibrary("stykcore")
    }

    external fun version(): String

    external fun abi(): String

    /** Decodes a .piv file image and returns a text summary or an error line. */
    external fun probePiv(data: ByteArray): String
}
