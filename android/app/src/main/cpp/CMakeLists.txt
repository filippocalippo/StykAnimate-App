cmake_minimum_required(VERSION 3.22.1)
project(stykcore LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Platform-independent core: no JNI or Android headers in core/.
# Host-side tests for these files live in android/core-tests/.
set(STYK_CORE_SOURCES
    core/styk_core.cpp
    core/piv.cpp
)

add_library(stykcore SHARED jni_bridge.cpp ${STYK_CORE_SOURCES})
target_include_directories(stykcore PRIVATE core)
target_compile_options(stykcore PRIVATE -Wall -Wextra)

find_library(log-lib log)
target_link_libraries(stykcore ${log-lib} z)
