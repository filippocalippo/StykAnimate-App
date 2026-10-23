package com.layouter787.stykport

/**
 * Kotlin side of the JNI bridge to the C++ core (libstykcore.so).
 *
 * Phase 0 only exposes diagnostics. Later phases add document decoding,
 * evaluation and rendering entry points here.
 */
object NativeCore {
    init {
        System.loadLibrary("stykcore")
    }

    external fun version(): String

    external fun abi(): String
}
