fn main() {
    tauri_build::build();

    let protoc = protoc_bin_vendored::protoc_bin_path().expect("vendored protoc unavailable");
    unsafe { std::env::set_var("PROTOC", protoc) };

    println!("cargo:rerun-if-changed=../../proto/bridge.proto");
    let mut config = prost_build::Config::new();
    config.type_attribute(".", "#[derive(serde::Serialize, serde::Deserialize)]");
    config.message_attribute(".", "#[serde(rename_all = \"camelCase\")]");
    config.enum_attribute(".", "#[serde(rename_all = \"camelCase\")]");
    config
        .compile_protos(&["../../proto/bridge.proto"], &["../../proto"])
        .expect("failed to compile bridge.proto");
}
