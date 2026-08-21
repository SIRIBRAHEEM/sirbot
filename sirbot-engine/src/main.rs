//! SIRBOT v2 — Sub-Millisecond Mint Engine
//! Pre-signs raw tx, blasts via HTTP/WebSocket to 15+ RPCs
//! Optional Flashbots bundle for guaranteed first-block inclusion

use clap::Parser;
use colored::*;
use futures_util::{SinkExt, StreamExt};
use k256::ecdsa::SigningKey;
use rlp::RlpStream;
use sha3::{Digest, Keccak256};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::net::TcpStream;
use tokio_tungstenite::{connect_async, WebSocketStream};

#[derive(Parser, Debug)]
#[command(name = "sirbot-engine", version = "2.0")]
struct Args {
    #[arg(short, long)]
    contract: String,

    #[arg(short, long, default_value = "base")]
    chain: String,

    #[arg(short, long, default_value = "1")]
    quantity: u64,

    #[arg(short, long)]
    private_key: String,

    #[arg(short, long)]
    target: u64,

    #[arg(long, default_value = "5.0")]
    max_fee_gwei: f64,

    #[arg(long, default_value = "1.0")]
    priority_gwei: f64,

    #[arg(long, default_value = "250000")]
    gas_limit: u64,

    /// Use Flashbots bundle (ETH only, skips public mempool)
    #[arg(long)]
    flashbots: bool,
}

struct Chain {
    name: String,
    chain_id: u64,
    rpcs: Vec<String>,
    ws_rpcs: Vec<String>,
    flashbots_rpc: Option<String>,
}

fn get_chain(name: &str) -> Chain {
    match name.to_lowercase().as_str() {
        "ethereum" | "eth" => Chain {
            name: "Ethereum".into(),
            chain_id: 1,
            rpcs: vec![
                "https://rpc.flashbots.net".into(),
                "https://rpc.mevblocker.net".into(),
                "https://eth.llamarpc.com".into(),
                "https://ethereum-rpc.publicnode.com".into(),
                "https://rpc.ankr.com/eth".into(),
                "https://eth.merkle.io".into(),
                "https://1rpc.io/eth".into(),
                "https://eth.drpc.org".into(),
                "https://eth-mainnet.public.blastapi.io".into(),
                "https://virginia.rpc.blxrbdn.com".into(),
                "https://eth.rpc.blxrbdn.com".into(),
            ],
            ws_rpcs: vec![
                "wss://eth.llamarpc.com".into(),
                "wss://ethereum-rpc.publicnode.com".into(),
                "wss://rpc.ankr.com/eth".into(),
            ],
            flashbots_rpc: Some("https://rpc.flashbots.net".into()),
        },
        "base" => Chain {
            name: "Base".into(),
            chain_id: 8453,
            rpcs: vec![
                "https://mainnet.base.org".into(),
                "https://base.llamarpc.com".into(),
                "https://base-rpc.publicnode.com".into(),
                "https://base.drpc.org".into(),
                "https://1rpc.io/base".into(),
                "https://base.publicnode.com".into(),
                "https://base-mainnet.g.alchemy.com/v2/demo".into(),
            ],
            ws_rpcs: vec![],
            flashbots_rpc: None,
        },
        "robinchain" | "robinhood" => Chain {
            name: "Robinchain".into(),
            chain_id: 4663,
            rpcs: vec!["https://rpc.mainnet.chain.robinhood.com".into()],
            ws_rpcs: vec![],
            flashbots_rpc: None,
        },
        _ => panic!("Unknown chain: {}", name),
    }
}

const SEADROP: &str = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
const FEE_RECIPIENT: &str = "0x0000a26b00c1F0DF003000390027140000fAa719";
const MINT_PUBLIC_SELECTOR: [u8; 4] = [0x9b, 0x3b, 0x76, 0xcc];

fn pad_left(data: &[u8], len: usize) -> Vec<u8> {
    let mut out = vec![0u8; len.saturating_sub(data.len())];
    out.extend_from_slice(data);
    out
}

fn keccak256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Keccak256::new();
    hasher.update(data);
    hasher.finalize().into()
}

fn build_calldata(contract: &str, quantity: u64) -> Vec<u8> {
    let mut data = Vec::with_capacity(136);
    data.extend_from_slice(&MINT_PUBLIC_SELECTOR);
    data.extend_from_slice(&pad_left(&hex::decode(contract.strip_prefix("0x").unwrap_or(contract)).unwrap(), 32));
    data.extend_from_slice(&pad_left(&hex::decode(FEE_RECIPIENT.strip_prefix("0x").unwrap_or(FEE_RECIPIENT)).unwrap(), 32));
    data.extend_from_slice(&[0u8; 32]);
    data.extend_from_slice(&pad_left(&quantity.to_be_bytes(), 32));
    data
}

/// RLP-encode a 32-byte big-endian integer and append to stream
fn encode_rlp_integer(stream: &mut RlpStream, bytes: &[u8; 32]) {
    // Strip leading zeros
    let start = bytes.iter().position(|&b| b != 0).unwrap_or(32);
    let stripped = &bytes[start..];

    if stripped.is_empty() {
        // Zero — RLP encode as empty byte string (0x80)
        stream.append_raw(&[0x80u8], 1);
    } else if stripped[0] >= 0x80 {
        // High bit set — prefix with 0x00 to distinguish from string
        let mut buf = Vec::with_capacity(stripped.len() + 1);
        buf.push(0x00);
        buf.extend_from_slice(stripped);
        let prefix = 0x80 + buf.len() as u8;
        let mut encoded = Vec::with_capacity(1 + buf.len());
        encoded.push(prefix);
        encoded.extend_from_slice(&buf);
        stream.append_raw(&encoded, 1);
    } else {
        let prefix = 0x80 + stripped.len() as u8;
        let mut encoded = Vec::with_capacity(1 + stripped.len());
        encoded.push(prefix);
        encoded.extend_from_slice(stripped);
        stream.append_raw(&encoded, 1);
    }
}

/// Pre-sign EIP-1559 transaction — called BEFORE T-0, zero latency at fire time
fn pre_sign_tx(
    private_key: &[u8],
    chain_id: u64,
    nonce: u64,
    to: &str,
    value: u128,
    calldata: &[u8],
    max_fee: u128,
    priority_fee: u128,
    gas_limit: u64,
) -> Vec<u8> {
    let mut stream = RlpStream::new();
    stream.begin_list(9);
    stream.append(&chain_id);
    stream.append(&nonce);
    stream.append(&priority_fee);
    stream.append(&max_fee);
    stream.append(&gas_limit);

    let to_bytes = hex::decode(to.strip_prefix("0x").unwrap_or(to)).unwrap_or_default();
    stream.append(&to_bytes);
    stream.append(&value);
    stream.append(&calldata);
    stream.begin_list(0); // access list

    let unsigned_rlp = stream.out();
    let tx_hash = keccak256(&unsigned_rlp);

    use k256::ecdsa::{SigningKey, signature::hazmat::PrehashSigner};
    let signing_key = SigningKey::from_bytes(private_key.into()).expect("Invalid key");
    let (signature, recovery_id) = signing_key.sign_prehash(tx_hash.as_ref().into()).expect("Signing failed");

    let mut final_stream = RlpStream::new();
    final_stream.begin_list(9);
    final_stream.append(&chain_id);
    final_stream.append(&nonce);
    final_stream.append(&priority_fee);
    final_stream.append(&max_fee);
    final_stream.append(&gas_limit);
    final_stream.append(&to_bytes);
    final_stream.append(&value);
    final_stream.append(&calldata);
    final_stream.begin_list(0);
    final_stream.append(&(recovery_id.to_byte() as u64));

    // RLP-encode signature r and s as integers
    let r_bytes: [u8; 32] = signature.r().to_bytes().into();
    let s_bytes: [u8; 32] = signature.s().to_bytes().into();
    encode_rlp_integer(&mut final_stream, &r_bytes);
    encode_rlp_integer(&mut final_stream, &s_bytes);

    let mut raw = vec![0x02u8];
    raw.extend_from_slice(&final_stream.out());
    raw
}

async fn rpc_post(client: &reqwest::Client, url: &str, payload: &serde_json::Value) -> Option<serde_json::Value> {
    let resp = client.post(url).json(payload).send().await.ok()?;
    let body: serde_json::Value = resp.json().await.ok()?;
    body.get("result").cloned()
}

#[tokio::main]
async fn main() {
    let args = Args::parse();
    let chain = get_chain(&args.chain);

    println!("{}", "╔═══════════════════════════════════════════╗".bright_cyan());
    println!("{}", "║     SIRBOT ENGINE v2.0 (Rust)             ║".bright_cyan());
    println!("{}", "║   Sub-Millisecond Pre-Signed Engine       ║".bright_cyan());
    println!("{}", "╚═══════════════════════════════════════════╝".bright_cyan());
    println!();

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .pool_max_idle_per_host(10)
        .build()
        .unwrap();

    let contract_hex = args.contract.strip_prefix("0x").unwrap_or(&args.contract);
    let contract_addr = hex::decode(contract_hex).expect("Invalid contract");

    println!("  {} Contract:  0x{}", "→".bright_green(), hex::encode(&contract_addr).bright_white());
    println!("  {} Chain:     {} (id {})", "→".bright_green(), chain.name.bright_white(), chain.chain_id);
    println!("  {} Quantity:  {}", "→".bright_green(), args.quantity);
    println!("  {} RPCs:      {} HTTP + {} WS", "→".bright_green(), chain.rpcs.len(), chain.ws_rpcs.len());
    if args.flashbots { println!("  {} Flashbots: ENABLED", "→".bright_green()); }
    println!();

    // ── Read chain state ──────────────────────────────────────────────
    println!("{}", "  [1/4] Reading SeaDrop...".bright_yellow());
    let mut drop_call = vec![0u8; 36];
    drop_call[0..4].copy_from_slice(&[0x60, 0xc4, 0xe1, 0x96]);
    drop_call[16..36].copy_from_slice(&contract_addr);

    let drop_data = rpc_post(&client, &chain.rpcs[0], &serde_json::json!({
        "jsonrpc":"2.0","method":"eth_call",
        "params":[{"to":SEADROP,"data":format!("0x{}",hex::encode(&drop_call))},"latest"],"id":1
    })).await;

    let mut mint_price: u128 = 0;
    if let Some(data) = &drop_data {
        if let Some(hex_str) = data.as_str() {
            let c = hex_str.strip_prefix("0x").unwrap_or(hex_str);
            if c.len() >= 192 {
                mint_price = u128::from_str_radix(&c[0..64], 16).unwrap_or(0);
                let start_time = u64::from_str_radix(&c[64..128], 16).unwrap_or(0);
                let end_time = u64::from_str_radix(&c[128..192], 16).unwrap_or(0);
                let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
                let price_eth = mint_price as f64 / 1e18;
                let status = if now >= end_time { "ENDED".red() } else if now >= start_time { "LIVE".green() } else { format!("UPCOMING ({}s)", start_time - now).yellow() };
                println!("  {} Price:     {} ETH", "→".bright_green(), format!("{:.6}", price_eth).bright_white());
                println!("  {} Status:    {}", "→".bright_green(), status);
            }
        }
    }
    println!();

    // ── Get nonce + chain id ──────────────────────────────────────────
    println!("{}", "  [2/4] Chain state...".bright_yellow());
    let chain_id = rpc_post(&client, &chain.rpcs[0], &serde_json::json!({
        "jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1
    })).await.and_then(|v| v.as_str().map(|s| u64::from_str_radix(s.strip_prefix("0x").unwrap_or(s), 16).unwrap_or(chain.chain_id))).unwrap_or(chain.chain_id);

    let pk_clean = args.private_key.strip_prefix("0x").unwrap_or(&args.private_key);
    let pk_bytes: [u8; 32] = hex::decode(pk_clean).expect("Invalid key").try_into().expect("Key must be 32 bytes");
    let signing_key = SigningKey::from_bytes(&pk_bytes.into()).expect("Invalid key");
    let verifying_key = signing_key.verifying_key();
    let pubkey_bytes = verifying_key.to_encoded_point(false);
    let pubkey_hash = keccak256(pubkey_bytes.as_bytes().get(1..).unwrap_or(&[]));
    let wallet_addr = hex::encode(&pubkey_hash[12..32]);

    let nonce_result = rpc_post(&client, &chain.rpcs[0], &serde_json::json!({
        "jsonrpc":"2.0","method":"eth_getTransactionCount",
        "params":[format!("0x{}",wallet_addr),"latest"],"id":1
    })).await;
    let nonce = nonce_result.and_then(|v| v.as_str().map(|s| u64::from_str_radix(s.strip_prefix("0x").unwrap_or(s), 16).unwrap_or(0))).unwrap_or(0);

    println!("  {} Wallet:    0x{}", "→".bright_green(), wallet_addr.bright_white());
    println!("  {} Nonce:     {}", "→".bright_green(), nonce);
    println!("  {} Chain ID:  {}", "→".bright_green(), chain_id);
    println!();

    // ── PRE-SIGN (the key to sub-ms) ─────────────────────────────────
    println!("{}", "  [3/4] Pre-signing (offline)...".bright_cyan());
    let sign_start = Instant::now();

    let calldata = build_calldata(&args.contract, args.quantity);
    let total_value = mint_price * args.quantity as u128;
    let max_fee_wei = (args.max_fee_gwei * 1e9) as u128;
    let priority_wei = (args.priority_gwei * 1e9) as u128;

    let raw_tx = pre_sign_tx(&pk_bytes, chain_id, nonce, SEADROP, total_value, &calldata, max_fee_wei, priority_wei, args.gas_limit);
    let raw_hex = hex::encode(&raw_tx);

    let sign_ms = sign_start.elapsed().as_secs_f64() * 1000.0;
    println!("  {} Signed in {:.3}ms — {} bytes", "✓".bright_green(), sign_ms, raw_tx.len());
    println!();

    // ── Open WebSocket connections ─────────────────────────────────────
    println!("{}", "  [4/4] Opening connections...".bright_cyan());
    let ws_start = Instant::now();
    let mut ws_sends: Vec<(usize, String, futures_util::stream::SplitSink<WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>, tokio_tungstenite::tungstenite::Message>)> = vec![];

    for (i, ws_url) in chain.ws_rpcs.iter().enumerate() {
        match connect_async(ws_url).await {
            Ok((ws_stream, _)) => {
                let (write, _) = ws_stream.split();
                ws_sends.push((i, ws_url.clone(), write));
                println!("    {} [WS-{}] {} ✓", "→".bright_green(), i, ws_url.dimmed());
            }
            Err(e) => {
                println!("    {} [WS-{}] {} ✗ {}", "→".bright_red(), i, ws_url.dimmed(), e);
            }
        }
    }

    let ws_ms = ws_start.elapsed().as_secs_f64() * 1000.0;
    println!("  {} {} connections ready ({:.1}ms)", "✓".bright_green(), ws_sends.len() + chain.rpcs.len(), ws_ms);
    println!();

    // ── WAIT ──────────────────────────────────────────────────────────
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    if args.target > now {
        let wait_secs = args.target - now;
        println!("  {} Waiting {}s...", "⏰".bright_yellow(), wait_secs);
        let target_instant = Instant::now() + Duration::from_secs(wait_secs);

        if wait_secs > 10 {
            tokio::time::sleep(Duration::from_secs(wait_secs - 10)).await;
        }

        // Final 10s — spin-wait
        loop {
            let remaining = target_instant.checked_duration_since(Instant::now());
            match remaining {
                Some(d) if d > Duration::from_millis(10) => {
                    print!("\r  ⏳ {:>5}.{:02}s   ", d.as_secs(), d.subsec_millis() / 10);
                    std::io::Write::flush(&mut std::io::stdout()).ok();
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                Some(_) => {
                    while Instant::now() < target_instant { std::hint::spin_loop(); }
                    break;
                }
                None => break,
            }
        }
    }

    // ── FIRE ──────────────────────────────────────────────────────────
    let fire_instant = Instant::now();
    println!();
    println!("  {}", "🚀 FIRING NOW!".bright_green().bold());
    println!();

    let payload = serde_json::json!({
        "jsonrpc":"2.0","method":"eth_sendRawTransaction",
        "params":["0x".to_string() + &raw_hex],"id":1
    });
    let payload_bytes = serde_json::to_vec(&payload).unwrap();

    // Flashbots bundle (ETH only)
    let flashbots_payload = if args.flashbots && chain.flashbots_rpc.is_some() {
        let fb_payload = serde_json::json!({
            "jsonrpc":"2.0","method":"eth_sendBundle",
            "params":[{
                "txs":["0x".to_string() + &raw_hex],
                "blockNumber": format!("0x{:x}", now + 2),
            }],"id":1
        });
        Some(fb_payload)
    } else {
        None
    };

    let mut blast_handles = vec![];

    // WebSocket blast
    for (i, url, mut write) in ws_sends {
        let pb = payload_bytes.clone();
        blast_handles.push(tokio::spawn(async move {
            let start = Instant::now();
            let result = write.send(tokio_tungstenite::tungstenite::Message::Binary(pb)).await;
            (i, url, start.elapsed(), result.is_ok())
        }));
    }

    // HTTP blast
    for (i, rpc_url) in chain.rpcs.iter().enumerate() {
        let rpc = rpc_url.clone();
        let p = payload.clone();
        let c = client.clone();
        blast_handles.push(tokio::spawn(async move {
            let start = Instant::now();
            let result = c.post(&rpc).json(&p).send().await;
            let elapsed = start.elapsed();
            let ok = result.is_ok();
            (i + 100, rpc, elapsed, ok)
        }));
    }

    // Flashbots blast
    if let Some(fb_payload) = flashbots_payload {
        let fb_rpc = chain.flashbots_rpc.clone().unwrap();
        let c = client.clone();
        blast_handles.push(tokio::spawn(async move {
            let start = Instant::now();
            let result = c.post(&fb_rpc).json(&fb_payload).send().await;
            let elapsed = start.elapsed();
            let ok = result.is_ok();
            (999, fb_rpc, elapsed, ok)
        }));
    }

    // Collect results
    let mut success = 0u32;
    let mut fastest = Duration::from_secs(999);

    for handle in blast_handles {
        if let Ok((i, url, elapsed, ok)) = handle.await {
            if elapsed < fastest { fastest = elapsed; }
            let ms = format!("{:.3}", elapsed.as_secs_f64() * 1000.0);
            let prefix = if i >= 999 { "FB" } else if i < 100 { "WS" } else { "HTTP" };
            if ok {
                println!("    {} [{}-{}] {} ✓ {}ms", "→".bright_green(), prefix, i % 100, url.dimmed(), ms.bright_white());
                success += 1;
            } else {
                println!("    {} [{}-{}] {} ✗ {}ms", "→".bright_red(), prefix, i % 100, url.dimmed(), ms);
            }
        }
    }

    let total_ms = fire_instant.elapsed().as_secs_f64() * 1000.0;

    println!();
    println!("  {}", "═══ RESULTS ═══".bright_white().bold());
    println!("  {} Total dispatch:  {:.3}ms", "→".bright_green(), total_ms);
    println!("  {} Fastest RTT:     {:.3}ms", "→".bright_green(), fastest.as_secs_f64() * 1000.0);
    println!("  {} Pre-sign:        {:.3}ms", "→".bright_green(), sign_ms);
    println!("  {} Endpoints hit:   {}/{}", "→".bright_green(), success, chain.rpcs.len() + chain.ws_rpcs.len() + if args.flashbots { 1 } else { 0 });
    println!("  {} TX size:         {} bytes", "→".bright_green(), raw_tx.len());
    println!();

    if fastest.as_millis() < 1 {
        println!("  {} SUB-MILLISECOND DISPATCH!", "⚡".bright_green().bold());
    } else if fastest.as_millis() < 100 {
        println!("  {} Under 100ms — very competitive!", "✓".bright_green());
    } else {
        println!("  {} Run on a VPS in US-East (closer to validators) for sub-100ms", "💡".bright_yellow());
    }
    println!();
}
