fn main() {
    let profile = std::env::var("PROFILE").unwrap_or_else(|_| "unknown".into());
    let opt = std::env::var("OPT_LEVEL").unwrap_or_default();
    let label = if profile == "release" && opt == "3" {
        "release"
    } else if profile == "release" && opt == "1" {
        "quick"
    } else {
        "debug"
    };
    println!("cargo:rustc-env=STYK_BUILD_PROFILE={label}");
}
