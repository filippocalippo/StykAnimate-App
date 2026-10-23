
# Stykanimate – 3D Model Converter

## Overview

This is a fork of **Stykanimate** focused on expanding its 3D capabilities and improving support for importing custom 3D models.

One of the key features I've developed is a **GLB-to-Stykanimate 3D Model Converter**, which allows users to convert static 3D models in `.glb` format into Stykanimate-compatible 3D models.

The converter is integrated into a web-based application, providing a simple interface for importing, naming, converting, and exporting 3D models.

## Features

- **GLB Model Import:** Import existing `.glb` files containing 3D models without animation.
- **Web-Based Interface:** Access the converter through a browser-based interface running locally on your computer.
- **Custom Model Naming:** Rename your imported model before converting it.
- **Automatic Conversion:** Convert the imported GLB model into a Stykanimate-compatible 3D model.
- **Rigged Model Export:** Generate a Stick 3D model with a rigged body for use in the supported Stykanimate workflow.
- **Downloadable Output:** Download the converted model directly from the web app.

## Usage Guide

Follow these steps to run the converter and convert your own 3D models.

### 1. Open the Project Folder

Navigate to your local Stykanimate fork on your computer and open the project folder in File Explorer.

### 2. Open Command Prompt in the Project Folder

1. Click the File Explorer address bar, where the current folder path is displayed.
2. Type `cmd`.
3. Press **Enter**.

This opens Command Prompt directly in your project folder.

### 3. Start the Converter

In Command Prompt, run the following command:

```bash
node scripts/glb-to-styk-web.mjs
```

Press **Enter** to start the converter.

Make sure Node.js is installed on your computer before running the command.

### 4. Open the Web App

Once the script starts, it should display a local URL in Command Prompt.

Copy the URL into your web browser or open the provided link directly.

**Important:** Keep the Command Prompt window running while using the converter.

### 5. Import Your GLB Model

In the converter web app:

1. Click the upload or import option.
2. Select the `.glb` file you want to convert.
3. Wait for the model to load.

### 6. Rename Your Model

Enter your preferred model name in the name field provided by the web app.

### 7. Convert and Download

1. Start the conversion process.
2. Wait for the conversion to finish.
3. Download the generated Stykanimate-compatible 3D model.

You can then use the exported model in the supported Stykanimate workflow.

## Project Goals

The goal of this fork is to expand Stykanimate's 3D functionality and make it easier for users to import custom 3D assets into the application.

The GLB-to-Stykanimate converter is a step toward a more accessible 3D workflow, allowing users to bring their own models into Stykanimate without manually recreating them from scratch.

## Requirements

- [Node.js](https://nodejs.org/) installed on your computer.
- A local copy of this repository.
- A `.glb` model to convert.
- A modern web browser.

## Notes

- The converter is designed for GLB models without existing animation.
- Keep the converter script running while accessing the local web app.
- Conversion results depend on the features supported by the converter and the target Stykanimate model format.
