//! Command-line front end of the Pivot codec.
//!
//! ```text
//! styk-piv import <file> [--native] [--web] [--time] [--out <body>]
//! styk-piv replay <recorded directory> [--only <text>]... [--dump] [--verbose] [--slowest N]
//! styk-piv zlib-compress <in> <out>
//! styk-piv zlib-inflate <in> <out>
//! ```

mod replay;

use std::process::ExitCode;
use std::time::Instant;

use styk_piv::{Codec, Limits, NATIVE_FRAMES_CONTENT_TYPE};

fn clock() -> Box<dyn Fn() -> f64> {
    let origin = Instant::now();
    Box::new(move || origin.elapsed().as_secs_f64() * 1000.0)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |name: &str| args.iter().any(|a| a == name);
    let option = |name: &str| args.iter().position(|a| a == name).and_then(|at| args.get(at + 1)).cloned();
    match args.first().map(String::as_str) {
        Some("zlib-compress") if args.len() == 3 => {
            let data = std::fs::read(&args[1]).expect("read input");
            let started = Instant::now();
            let out = styk_piv::internals::zlib_compress(&data);
            eprintln!("compressed {} -> {} bytes in {:.3} s", data.len(), out.len(), started.elapsed().as_secs_f64());
            std::fs::write(&args[2], out).expect("write output");
            ExitCode::SUCCESS
        }
        Some("zlib-inflate") if args.len() == 3 => {
            let data = std::fs::read(&args[1]).expect("read input");
            let started = Instant::now();
            match styk_piv::internals::zlib_inflate(&data, 256 * 1024 * 1024 + 1) {
                Ok((out, end)) => {
                    eprintln!("inflated {} -> {} bytes ({end}) in {:.3} s", data.len(), out.len(), started.elapsed().as_secs_f64());
                    std::fs::write(&args[2], out).expect("write output");
                    println!("{end}");
                }
                Err(message) => println!("error:{message}"),
            }
            ExitCode::SUCCESS
        }
        Some("zlib-inflate-dir") if args.len() >= 2 => {
            // One line per file: name, outcome (or the zlib error), output length, and an Adler-32 of the output.
            let limit: usize = option("--limit").and_then(|l| l.parse().ok()).unwrap_or(256 * 1024 * 1024 + 1);
            let mut names: Vec<_> = std::fs::read_dir(&args[1]).expect("read directory").filter_map(|e| e.ok()).map(|e| e.path()).collect();
            names.sort();
            for path in names {
                let data = std::fs::read(&path).expect("read input");
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                match styk_piv::internals::zlib_inflate(&data, limit) {
                    Ok((out, end)) => {
                        let sum = out.iter().fold((1u32, 0u32), |(a, b), &x| ((a + x as u32) % 65521, (b + a + x as u32) % 65521));
                        println!("{name}\t{end}\t{}\t{}", out.len(), (sum.1 << 16) | sum.0);
                    }
                    Err(message) => println!("{name}\terror:{message}"),
                }
            }
            ExitCode::SUCCESS
        }
        Some("replay") if args.len() >= 2 => {
            let root = std::path::Path::new(&args[1]);
            if !root.is_dir() {
                eprintln!("styk-piv replay: {} does not exist; record it first with engine/tools/piv/oracle.py", root.display());
                return ExitCode::from(2);
            }
            let only: Vec<String> = args.iter().enumerate().filter(|(_, a)| *a == "--only").filter_map(|(at, _)| args.get(at + 1).cloned()).collect();
            let started = Instant::now();
            let mut summary = replay::replay(root, &replay::Options { only, dump: flag("--dump"), verbose: flag("--verbose") });
            for failure in &summary.failures {
                println!("DIFF {failure}");
            }
            println!("replayed {} requests of {} scenarios in {:.1} s", summary.steps, summary.scenarios, started.elapsed().as_secs_f64());
            let mut different = 0;
            for (kind, tally) in &summary.by_kind {
                println!("  {kind:<24} {:>5} compared  {:>5} identical  {:>4} differing", tally.same + tally.different, tally.same, tally.different);
                different += tally.different;
            }
            println!("  error messages that differ (status and code equal): {}", summary.message_differences);
            if let Some(count) = option("--slowest").and_then(|n| n.parse::<usize>().ok()) {
                summary.slowest.sort_by(|a, b| b.0.total_cmp(&a.0));
                println!("  slowest requests (Python seconds, Rust seconds):");
                for (python, rust, label) in summary.slowest.iter().take(count) {
                    println!("    {python:>8.3} {rust:>8.3}  {label}");
                }
            }
            if different == 0 && summary.message_differences == 0 { ExitCode::SUCCESS } else { ExitCode::from(1) }
        }
        Some("numbers") if args.len() == 3 => {
            // For each little-endian double of the input: repr, '.9g', the fingerprint spelling,
            // and math.hypot with the next double.
            let data = std::fs::read(&args[1]).expect("read input");
            let values: Vec<f64> = data.as_chunks::<8>().0.iter().map(|c| f64::from_le_bytes(*c)).collect();
            let mut out = String::new();
            for (index, &value) in values.iter().enumerate() {
                let next = values[(index + 1) % values.len()];
                out.push_str(&format!(
                    "{} {} {} {}\n",
                    styk_piv::internals::float_repr(value),
                    styk_piv::internals::format_g9(value),
                    styk_piv::internals::py_number(value),
                    styk_piv::internals::float_repr(styk_piv::internals::py_hypot(value, next))
                ));
            }
            std::fs::write(&args[2], out).expect("write output");
            ExitCode::SUCCESS
        }
        Some("profile") if args.len() >= 2 => {
            let data = std::fs::read(&args[1]).expect("read input");
            let now = clock();
            match styk_piv::internals::profile_import(&data, &*now) {
                Ok(stages) => {
                    for (stage, value) in stages {
                        println!("{value:>12.1}  {stage}");
                    }
                    ExitCode::SUCCESS
                }
                Err(error) => {
                    eprintln!("{error}");
                    ExitCode::from(1)
                }
            }
        }
        Some("import") if args.len() >= 2 => {
            let path = std::path::Path::new(&args[1]);
            let data = std::fs::read(path).expect("read input");
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("imported.piv");
            let mut codec = Codec::new(if flag("--web") { Limits::web() } else { Limits::desktop() });
            codec.set_clock(clock());
            let mut headers = Vec::new();
            if flag("--native") {
                headers.push(("Accept".to_string(), NATIVE_FRAMES_CONTENT_TYPE.to_string()));
            }
            let target = format!("/api/import?filename={}", name.replace('%', "%25").replace('&', "%26").replace('+', "%2B").replace('#', "%23").replace(' ', "%20"));
            let started = Instant::now();
            let response = codec.request("POST", &target, &headers, &data, &|| false);
            let elapsed = started.elapsed().as_secs_f64();
            if flag("--time") {
                eprintln!("{}: status {} body {} bytes in {:.3} s", name, response.status, response.body.len(), elapsed);
            }
            if let Some(out) = option("--out") {
                std::fs::write(out, &response.body).expect("write output");
            } else if response.status != 200 {
                println!("{}", String::from_utf8_lossy(&response.body));
            }
            if response.status == 200 { ExitCode::SUCCESS } else { ExitCode::from(1) }
        }
        _ => {
            eprintln!("usage: styk-piv import <file> [--native] [--web] [--time] [--out <body>]");
            ExitCode::from(2)
        }
    }
}
