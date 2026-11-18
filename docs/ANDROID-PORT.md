# Port Android (StykPort)

Objetivo: port completo do StykAnimate para Android, com núcleo em C++ (NDK) e interface nativa em Kotlin/Compose. O trabalho vive na branch `android-port`, na pasta `android/`.

Escopo de formatos: **só o formato nativo do StykAnimate** (`.styk`, `.stkz`, `.stykmov`). Compatibilidade com Pivot (`.piv`) e Stick Nodes não faz parte do port.

Observação: o app é GPL v3 e o README pede nome e ícone diferentes para versões modificadas. `StykPort` é um nome provisório.

## Arquitetura

- `android/app/src/main/cpp/core/`: núcleo em C++17 puro, sem JNI nem headers do Android.
- `android/app/src/main/cpp/jni_bridge.cpp`: única camada JNI.
- `android/app/src/main/kotlin/`: interface (Compose), arquivos (SAF), exportação (MediaCodec), áudio.
- `android/core-tests/`: testes do núcleo que rodam na máquina do CI (g++, zlib e python3, com AddressSanitizer e UBSan). O Gradle os executa antes de cada build quando `CI=true` (GitHub Actions). Os arquivos de teste dos contêineres são gerados com a lógica do codificador original (`backend/native_format.py`).

## Fases

| Fase | Conteúdo | Origem no projeto web/desktop |
| --- | --- | --- |
| 0 | Esqueleto Gradle + CMake + JNI + CI que gera o APK (feito) | (novo) |
| 1 | Formato nativo (detalhe abaixo) | `backend/native_format.py`, `src/native-container.mjs` |
| 2 | Modelo e avaliação: esquema do documento, geometria, poses, canais, easing, IK, rig, câmera, movieclips | `src/pivot/`, `src/animation-*.mjs`, `src/ik*.mjs`, `src/rig-*.mjs`, `src/camera-*.mjs`, `src/movieclip*.mjs` |
| 3 | Renderizador 2D (Vulkan ou OpenGL ES) e reprodução | `src/renderer*.mjs`, `src/playback*.mjs`, `src/prepared-frames.mjs` |
| 4 | UI Kotlin: viewer, timeline simples, gestos de toque e caneta, abrir/salvar (SAF) | `src/app.mjs`, `src/shell/`, `src/touch/`, `src/ui/`, timelines |
| 5 | Editor: comandos, undo/redo, Build Figure, camadas de desenho, clipboard | `src/editor*.mjs`, `src/builder-*.mjs`, `src/drawing-*.mjs` |
| 6 | Exportação (MP4/WebM/GIF/PNG/SVG), áudio, VFX, biblioteca, traduções | `src/export-*.mjs`, `src/audio-*.mjs`, `src/vfx-*.mjs`, `src/locales/` |
| 7 | Desempenho, polimento, assinatura de release | - |

### Fase 1 em etapas

| Etapa | Conteúdo | Estado |
| --- | --- | --- |
| 1a | Contêiner `.styk`/`.stkz`/`.stykmov` v1 e v2 (zlib), JSON, SHA-256, marcadores binários, JSON simples e envelope `stykanimate`; escrita v1 | feito, com testes |
| 1b | Decodificador zstd (codec 2): arquivos salvos pelo app web/desktop usam zstd quando disponível | pendente |
| 1c | Escrita v2 (arrays numéricos e blobs em seções), serialização do documento para JSON | pendente |

O documento nativo é um JSON. O esquema dele (`figure_types`, `keyframes`, `backgrounds`, `_styk`...) vira estruturas C++ tipadas no início da Fase 2.

## Regras de trabalho

1. Cada fase termina com o APK compilando no CI.
2. Cada módulo portado vem com teste. Sem arquivos reais à mão, os testes usam arquivos sintéticos gerados pelo codificador do projeto; a validação final é abrir arquivos reais no aparelho.
3. O núcleo C++ nunca depende de JNI; só `jni_bridge.cpp` conhece Android.

## Como obter o APK

GitHub > aba Actions > workflow Android > último run > artefato `stykport-debug-apk`.
