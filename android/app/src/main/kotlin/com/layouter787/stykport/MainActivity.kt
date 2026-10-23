package com.layouter787.stykport

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    ProbeScreen()
                }
            }
        }
    }
}

@Composable
fun ProbeScreen() {
    val context = LocalContext.current
    var report by remember { mutableStateOf("Nenhum arquivo aberto.") }
    var busy by remember { mutableStateOf(false) }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            busy = true
            report = "Lendo..."
            Thread {
                val text = try {
                    val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
                        ?: ByteArray(0)
                    val start = System.nanoTime()
                    val summary = NativeCore.probePiv(bytes)
                    val ms = (System.nanoTime() - start) / 1_000_000
                    "Arquivo: ${bytes.size} bytes\n$summary\nDecodificado em $ms ms"
                } catch (e: Throwable) {
                    "ERROR: ${e.message}"
                }
                report = text
                busy = false
            }.start()
        }
    }

    Column(
        modifier = Modifier
            .padding(24.dp)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("StykPort", style = MaterialTheme.typography.headlineMedium)
        Text("Fase 1a: decodificador PIV v5")
        Text("Core: ${NativeCore.version()}  |  ABI: ${NativeCore.abi()}")
        Button(onClick = { picker.launch(arrayOf("*/*")) }, enabled = !busy) {
            Text("Abrir arquivo .piv")
        }
        Text(report, fontFamily = FontFamily.Monospace)
    }
}
