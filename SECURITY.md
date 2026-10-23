# Security policy

This is an unaudited application. Do not describe it as Proton-equivalent or as offering a guarantee against a malicious application distributor.

## Reporting

Report vulnerabilities privately using GitHub's private vulnerability reporting when enabled. Do not put private keys, session cookies, passwords, or real conversation data in public issues. Until private reporting is enabled, request a private contact from the repository owner without posting exploit details.

## Threat model

The client encrypts message text, reply identifiers, edits, reactions, pins, and file metadata before transmission. The application database stores encrypted envelopes, encrypted private-key vaults, public identity keys, and authentication verifiers. The server does not receive the password, the vault decryption key, a plaintext message, or a plaintext attachment through the implemented application protocol.

The server can see usernames, display names, guild/channel names and types, membership, requests, timestamps, ciphertext lengths, IP addresses while connected, typing events, and voice room participation. Profile biographies, pronouns, status, banner colors and server descriptions are public metadata within the application. Profile/server icons are cropped to 128×128 WebP and encrypted before uploading through the file adapter. Their decryption descriptors are intentionally shared as profile metadata, so these public images do not have conversation confidentiality. Clients only display decoded 128×128 WebP images and do not render supplied SVG/HTML. The attachment proxy sees encrypted bytes and file IDs; end2end.tech sees the proxy IP, upload size and timing. A downloaded encrypted attachment is accessible to anyone possessing its external file ID; plaintext additionally requires its random encryption key. File IDs and keys are carried inside encrypted messages.

## Protocol v1

- Identity: independent ECDSA P-256 signing and ECDH P-256 encryption key pairs, generated on the client with Web Crypto.
- Password processing: PBKDF2-HMAC-SHA-256, 600,000 iterations, random 256-bit account salt, separate application/version/purpose labels for authentication and vault keys. This is not SRP or OPAQUE. The server receives the derived authentication secret and stores an Argon2id verifier (64 MiB, three iterations). Do not reuse derived authentication secrets across services.
- Vault: AES-256-GCM, random 96-bit nonce, username and protocol version as authenticated context. Server-side password recovery cannot recover this vault.
- Each message/event: independent 256-bit content key and 96-bit nonce; AES-GCM authenticated context includes the complete canonical header (ID, room, author, membership version, timestamp, ephemeral public key).
- Key envelopes: a fresh ECDH ephemeral key pair per event; ephemeral/private-to-recipient/public ECDH, then HKDF-SHA-256 with a versioned salt and header/recipient context, then AES-GCM wrapping of the content key. Each current member receives a separate key envelope.
- Authenticity: ECDSA-SHA-256 signature over canonical JSON for the entire header, recipient envelopes, and encrypted payload. Context and signatures are checked before rendering.
- Guild membership: the owner signs a versioned complete member list, including the exact identity keys. Recipients validate this signature. Historical member-list signatures are retained to authenticate older messages. The server requires current membership/version on each new event. A database `UNIQUE(owner)` enforces one owned guild per account.
- Trust: public keys are pinned in browser localStorage on first use (TOFU). Invite links contain the owner's public keys in the URL fragment. Users can compare SHA-256 fingerprints over another communication channel and mark them as verified. A changed pinned identity blocks sending. Guild IDs are pinned to owner identities, and DM IDs are pinned to their two participant identities, so replacing the whole signed directory with a different owner/peer is also rejected in an existing trust state. A per-browser maximum membership version detects a lower current roster version.
- Files: random AES-256-GCM key/nonce per file; encrypt before `POST /upload`; store only a random `.enc` filename externally. The file name, MIME, size, hash, encryption key/nonce, file ID and deletion secret travel inside the signed encrypted message. SHA-256 and GCM authentication are checked before saving plaintext to disk. No automatic remote resource previews or HTML rendering.
- Voice/video/screen: browser WebRTC DTLS-SRTP, peer-to-peer mesh, up to six connections. SDP and ICE are signed and encrypted using the same identity/envelope mechanism. The service does not terminate the media encryption. A TURN relay may carry encrypted media. ICE reveals participant IPs to peers and configured STUN/TURN operators.

## Explicit limitations

- No independent cryptographic/security audit; no Proton code or Proton key transparency infrastructure is integrated.
- No public append-only key transparency log, cross-device consistency proof, transparency gossip or authenticated account directory. TOFU does not stop first-contact key substitution; compare fingerprints and invite-owner keys independently.
- No Double Ratchet, MLS, post-compromise security or forward secrecy for stored messages. Long-term recipient key compromise can expose historical envelopes. The ephemeral sender key alone does not provide recipient-compromise forward secrecy.
- The server that serves this web client can replace JavaScript and capture keys/passwords on a later visit. CSP protects against some injection, not a malicious origin. For a stronger distribution boundary, ship independently signed native clients with reproducible builds and verified updates.
- A compromised endpoint/browser extension, XSS in trusted code, malware, screenshots, or an authorized recipient can expose plaintext. localStorage pins can be cleared or tampered with by code controlling that origin/device. New browsers have a fresh TOFU trust state.
- No cryptographic global ordering/completeness guarantee. A malicious server can suppress, delay, reorder, or replay historical valid events in a new browser. IDs are deduplicated in the current client history; signatures do not prove that the server delivered everything.
- Deletion/editing publishes a signed encrypted event; previously delivered ciphertext and recipient copies remain. Deleted external files may remain in upstream backups. Deletion secrets are visible to conversation recipients after decryption.
- New members cannot decrypt messages sent before approval. Removed members retain old messages and keys; future events omit them. An owner can add any person they approve; recipients must review the member list.
- Browser sessions expire in seven days. Login unlocks the vault on each reload. There is no password reset, account deletion, passkey/2FA, independent device-key revocation, or automatic trust synchronization in this version. Password changes re-encrypt the existing identity vault and invalidate other sessions; they do not rotate identity keys. Authenticated users can view and revoke their other sessions.
- Search runs in decrypted client history. At most 10,000 events are loaded per synchronization call; additional events load on another synchronization. There is no server plaintext search or content moderation pipeline.
- Rate limits apply to a single process and do not provide full denial-of-service protection. Add connection/IP/rate controls and request timeouts at the reverse proxy. Keep one Bun process for this SQLite deployment; horizontal scaling needs shared fanout and coordinated limits.

## Deployment

Use a dedicated HTTPS origin, a patched Bun runtime, strict control over who can modify deployed assets, and restricted access to SQLite plus backups. Do not terminate HTTPS on an untrusted host. Keep `APP_ORIGIN` exactly equal to the browser origin. Bind Bun to loopback behind the TLS reverse proxy. Cookie authentication uses HttpOnly, SameSite=Strict, and the Secure/__Host- attributes on HTTPS. State-changing HTTP and WebSocket handshakes require an exact Origin match. SQL uses prepared statements. Static serving is an explicit allowlist. Request sizes, session lifetime, and rates are bounded. The application does not trust forwarded IP headers.
