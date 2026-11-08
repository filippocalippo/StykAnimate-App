//! Schemas generated from the protocol's operation registry and shared size constants.
use serde_json::{Value, json};
pub fn protocol() -> Value {
    let operations:Vec<_>=crate::protocol::OPS.iter().map(|op|{
  let args=match *op {
   "trace.start"=>json!({"cap_mb":{"type":"integer","minimum":1,"maximum":256}}),
   "param.set"=>json!({"name":{"type":"string","maxLength":128},"value":{"type":["number","integer","boolean","string"],"maxLength":2048}}),
   "doc.tree"|"doc.node"|"state.get"=>json!({"path":{"type":"array","maxItems":32,"items":{"type":"string","maxLength":2048}},"cursor":{"type":"integer","minimum":0}}),
   "trace.ring"|"threads.get"|"history.list"=>json!({"cursor":{"type":"integer","minimum":0}}),
   _=>json!({}),
  };
  let required = if *op == "hello" {vec!["id","op","version"]} else {vec!["id","op"]};
  json!({"type":"object","required":required,"properties":{"id":{"type":"integer","minimum":0},"op":{"const":op},"version":{"const":1},"detail":{"enum":["short","full"]},"args":{"type":"object","properties":args}},"additionalProperties":false})
 }).collect();
    json!({"$schema":"https://json-schema.org/draft/2020-12/schema","title":"StykAnimate developer protocol v1","oneOf":[{"$ref":"#/$defs/request"},{"$ref":"#/$defs/response"}],"x-byte-limits":{"request":crate::protocol::MAX_REQUEST,"short":crate::answer::SHORT_BYTES,"full":crate::protocol::MAX_RESPONSE,"rows":crate::answer::ROWS,"string":crate::answer::STRING_BYTES},"$defs":{"request":{"oneOf":operations},"error":{"type":"object","required":["what","where","input","cause","hint"],"properties":{"what":{"type":"string"},"where":{"type":"string"},"input":{},"cause":{"type":"string"},"hint":{"type":"string"}}},"response":{"oneOf":[{"type":"object","required":["id","ok","result","truncated","more"],"properties":{"id":{"type":["integer","null"]},"ok":{"const":true},"result":{},"truncated":{"type":"boolean"},"more":{"type":["integer","null"]}}},{"type":"object","required":["id","ok","error"],"properties":{"id":{"type":["integer","null"]},"ok":{"const":false},"error":{"$ref":"#/$defs/error"}}}]}}})
}
pub fn profile() -> Value {
    json!({"$schema":"https://json-schema.org/draft/2020-12/schema","title":"StykAnimate headless profile v1","type":"object","required":["format","scenario","input_hash","clock","build_profile","samples_ms","summary","budgets"],"properties":{"format":{"const":"stykprofile/1"},"scenario":{"type":"string"},"input_hash":{"type":"string"},"clock":{"const":"real"},"build_profile":{"enum":["release","quick","debug"]},"samples_ms":{"type":"array","minItems":3,"maxItems":32,"items":{"type":"number","minimum":0}},"summary":{"type":"object"},"budgets":{"type":"array","maxItems":64}}})
}
pub fn bytes(value: &Value) -> Vec<u8> {
    let mut bytes = serde_json::to_vec_pretty(value).unwrap_or_default();
    bytes.push(b'\n');
    bytes
}
