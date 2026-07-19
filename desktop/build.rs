fn main() {
    let protoc = protoc_bin_vendored::protoc_bin_path().expect("vendored protoc unavailable");
    unsafe { std::env::set_var("PROTOC", protoc) };
    println!("cargo:rerun-if-changed=../proto/bridge.proto");
    prost_build::Config::new()
        .compile_protos(&["../proto/bridge.proto"], &["../proto"])
        .expect("failed to compile bridge.proto");
}
