import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { PythonTelosBridgeClient, type TelosBridgeRequest } from "../src/policy/telos-bridge.js";

const PAYLOAD: TelosBridgeRequest = {
  method: "GET",
  url: "http://localhost:11434/api/tags",
  purpose: "health_probe",
  allowed_endpoints: ["http://localhost:11434"],
  allow_remote: false,
  allowed_hosts: [],
  headers: {},
};

function nodeClient(script: string): PythonTelosBridgeClient {
  return new PythonTelosBridgeClient(process.execPath, ["-e", script]);
}

describe("PythonTelosBridgeClient", () => {
  test("round-trips one JSONL request through the language-neutral bridge boundary", async () => {
    const script = `
      process.stdin.setEncoding('utf8');
      let input='';
      process.stdin.on('data', c => input += c);
      process.stdin.on('end', () => {
        const req = JSON.parse(input.trim());
        process.stdout.write(JSON.stringify({ok_bridge:true,result:{ok:true,status:200,headers:[],body_base64:'',final_url:req.url,endpoint:['http','localhost',11434]}})+'\\n');
      });
    `;
    const envelope = await nodeClient(script).request(PAYLOAD);
    assert.equal(envelope.ok_bridge, true);
    if (envelope.ok_bridge) assert.equal(envelope.result.final_url, PAYLOAD.url);
  });

  test("preserves structured Telos denials", async () => {
    const script = `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ok_bridge:false,error:{code:'purpose_denied',message:'denied'}})+'\\n'));`;
    const envelope = await nodeClient(script).request(PAYLOAD);
    assert.deepEqual(envelope, { ok_bridge: false, error: { code: "purpose_denied", message: "denied" } });
  });

  test("fails closed on malformed bridge output", async () => {
    const script = `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('not-json\\n'));`;
    await assert.rejects(() => nodeClient(script).request(PAYLOAD), SyntaxError);
  });

  test("cancellation terminates the in-flight bridge process", async () => {
    const script = `process.stdin.resume(); setTimeout(() => {}, 30000);`;
    const controller = new AbortController();
    const pending = nodeClient(script).request(PAYLOAD, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(
      () => pending,
      (err: unknown) => err instanceof Error && err.name === "AbortError",
    );
  });
});
