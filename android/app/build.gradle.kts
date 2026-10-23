plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.layouter787.stykport"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.layouter787.stykport"
        minSdk = 26
        targetSdk = 35
        versionCode = 2
        versionName = "0.1.0-phase1a"

        ndk {
            abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64")
        }
        externalNativeBuild {
            cmake {
                cppFlags += "-std=c++17"
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
    }
    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }
}

// Runs the C++ core unit tests (android/core-tests) on the build machine.
// Only active on CI; skipped when no host g++/zlib is available.
val hostCoreTests by tasks.registering(Exec::class) {
    description = "Builds and runs the C++ core unit tests on the host (CI only)."
    commandLine("sh", "${rootDir}/core-tests/run.sh")
    onlyIf { System.getenv("CI") == "true" }
}

tasks.matching { it.name == "preBuild" }.configureEach {
    dependsOn(hostCoreTests)
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2024.10.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.core:core-ktx:1.15.0")
}
