# Port Android (StykPort)

Objetivo: port completo do StykAnimate para Android, com nucleo em C++ (NDK) e interface nativa em Kotlin/Compose. O trabalho vive na branch `android-port`, na pasta `android/`.

Observacao: o app e GPL v3 e o README pede nome e icone diferentes para versoes modificadas. `StykPort` e um nome provisorio.

## Arquitetura

- `android/app/src/main/cpp/core/`: nucleo em C++17 puro, sem JNI nem headers do Android.
- `android/app/src/main/cpp/jni_bridge.cpp`: unica camada JNI.
- `android/app/src/main/kotlin/`: interface (Compose), arquivos (SAF), exportacao (MediaCodec), audio.
- `android/core-tests/`: testes do nucleo que rodam no computador do CI (g++ + zlib, com AddressSanitizer e UBSan). O Gradle os executa antes de cada build quando a variavel `CI=true` (GitHub Actions).

## Fases

| Fase | Conteudo | Origem no projeto web/desktop |
| --- | --- | --- |
| 0 | Esqueleto Gradle + CMake + JNI + CI que gera o APK (feito) | (novo) |
| 1 | Formatos de arquivo (detalhe abaixo) | `codecs/`, `backend/native_format.py`, `src/native-container.mjs`, `src/sticknodes/` |
| 2 | Modelo e avaliacao: geometria, poses, canais, easing, IK, rig, camera, movieclips | `src/pivot/`, `src/animation-*.mjs`, `src/ik*.mjs`, `src/rig-*.mjs`, `src/camera-*.mjs`, `src/movieclip*.mjs` |
| 3 | Renderizador 2D (Vulkan ou OpenGL ES) e reproducao | `src/renderer*.mjs`, `src/playback*.mjs`, `src/prepared-frames.mjs` |
| 4 | UI Kotlin: viewer, timeline simples, gestos de toque e caneta, abrir/salvar (SAF) | `src/app.mjs`, `src/shell/`, `src/touch/`, `src/ui/`, timelines |
| 5 | Editor: comandos, undo/redo, Build Figure, camadas de desenho, clipboard | `src/editor*.mjs`, `src/builder-*.mjs`, `src/drawing-*.mjs` |
| 6 | Exportacao (MP4/WebM/GIF/PNG/SVG), audio, VFX, biblioteca, traducoes | `src/export-*.mjs`, `src/audio-*.mjs`, `src/vfx-*.mjs`, `src/locales/` |
| 7 | Desempenho, polimento, assinatura de release | - |

### Fase 1 em etapas

| Etapa | Conteudo | Origem | Estado |
| --- | --- | --- | --- |
| 1a | PIV v5 (sem imagens/texto): cabecalho, fundos, figuras, keyframes, camera, fps | `codecs/piv_codec.py` | feito, com testes |
| 1b | Tabelas laterais de imagem e texto dentro das figuras | `codecs/piv_side_tables.py` | pendente |
| 1c | PIV legado v1 a v4 | `codecs/piv_legacy*.py` | pendente |
| 1d | Arquivos `.stk` de figura | `backend/test_stk_topology.py`, `codecs/pivot_decoder.py` | pendente |
| 1e | Contêiner nativo STYK/STKZ | `backend/native_format.py`, `src/native-container.mjs` | pendente |
| 1f | Pacotes Stick Nodes | `src/sticknodes/` | pendente |
| 1g | Escrita (salvar `.piv`/STYK) | `codecs/piv_*writer.py`, `piv_document.py` | pendente |

## Regras de trabalho

1. Cada fase termina com o APK compilando no CI.
2. Cada modulo portado vem com teste. Sem o corpus de projetos Pivot, os testes usam arquivos sintéticos; a validacao final e abrir arquivos reais no aparelho.
3. O nucleo C++ nunca depende de JNI; so `jni_bridge.cpp` conhece Android.

## Como obter o APK

GitHub > aba Actions > workflow Android > ultimo run > artefato `stykport-debug-apk`.
