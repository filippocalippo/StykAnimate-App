# Port Android (StykPort)

Objetivo: port completo do StykAnimate para Android, com nucleo em C++ (NDK) e interface nativa em Kotlin/Compose. O trabalho vive na branch `android-port`, na pasta `android/`.

Observacao: o app e GPL v3 e o README pede nome e icone diferentes para versoes modificadas. `StykPort` e um nome provisorio.

## Arquitetura

- `android/app/src/main/cpp/core/`: nucleo em C++17 puro, sem JNI nem headers do Android. Isso permite testar no host (CI) com os mesmos arquivos de teste do projeto original.
- `android/app/src/main/cpp/jni_bridge.cpp`: unica camada JNI.
- `android/app/src/main/kotlin/`: interface (Compose), arquivos (SAF), exportacao (MediaCodec), audio.

## Fases

| Fase | Conteudo | Origem no projeto web/desktop |
| --- | --- | --- |
| 0 | Esqueleto Gradle + CMake + JNI + CI que gera o APK | (novo) |
| 1 | Conteineres e decodificadores: PIV, STK, STYK/STKZ, Stick Nodes. Testes de equivalencia contra o Python | `codecs/`, `backend/native_format.py`, `src/native-container.mjs`, `src/sticknodes/` |
| 2 | Modelo e avaliacao: geometria, poses, canais, easing, IK, rig, camera, movieclips | `src/pivot/`, `src/animation-*.mjs`, `src/ik*.mjs`, `src/rig-*.mjs`, `src/camera-*.mjs`, `src/movieclip*.mjs` |
| 3 | Renderizador 2D (Vulkan ou OpenGL ES) e reproducao | `src/renderer*.mjs`, `src/playback*.mjs`, `src/prepared-frames.mjs` |
| 4 | UI Kotlin: viewer, timeline simples, gestos de toque e caneta, abrir/salvar (SAF) | `src/app.mjs`, `src/shell/`, `src/touch/`, `src/ui/`, timelines |
| 5 | Editor: comandos, undo/redo, Build Figure, camadas de desenho, clipboard | `src/editor*.mjs`, `src/builder-*.mjs`, `src/drawing-*.mjs` |
| 6 | Exportacao (MP4/WebM/GIF/PNG/SVG), audio, VFX, biblioteca, traducoes | `src/export-*.mjs`, `src/audio-*.mjs`, `src/vfx-*.mjs`, `src/locales/` |
| 7 | Desempenho, polimento, assinatura de release | - |

## Regras de trabalho

1. Cada fase termina com o APK compilando no CI.
2. Cada modulo portado vem com teste que compara com o comportamento do original.
3. O nucleo C++ nunca depende de JNI; so `jni_bridge.cpp` conhece Android.

## Como obter o APK

GitHub > aba Actions > workflow Android > ultimo run > artefato `stykport-debug-apk`.
