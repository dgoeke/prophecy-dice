#!/usr/bin/env python3
"""verify.py — independent verifier for wotw-column/1 ledgers (stdlib only).

This file is deliberately self-contained and duplicated from the TypeScript
implementation: the point is that a skeptical reader can audit it without
trusting any shared module. The arbiter for cross-implementation agreement
is spec/vectors.json (spec/protocol.md §9).

Implements both the §2 normative primitives and full semantic ledger
verification. The `--vectors` mode cross-checks the published known-answer
and adversarial cases without reading any TypeScript implementation.

Usage:
  verify.py --vectors spec/vectors.json     check test vectors, exit 0/1
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import sys
import unicodedata

# ---- §2.2 constants (UTF-8, no trailing NUL) --------------------------------

SALT = b"wotw-column/1/salt"
TAG_CHAIN = b"wotw-column/1/chain"
TAG_DIE = b"wotw-column/1/die/20"
TAG_CONTEXT = b"wotw-column/1/context"
TAG_DC = b"wotw-column/1/dc"
TAG_MOD = b"wotw-column/1/mod"
TAG_LABEL = b"wotw-column/1/label"
TAG_ENTROPY = b"wotw-column/1/genesis-entropy"
TAG_CONFIG = b"wotw-column/1/genesis-configuration"
INFO_PREFIX = "wotw-column/1/slot/"
TAG_SALT_DC = b"wotw-column/1/salt/dc"
TAG_SALT_MOD = b"wotw-column/1/salt/mod"
TAG_SALT_CTX = b"wotw-column/1/salt/context"
LABEL_INFO = "/#label"  # '#' cannot occur in a lane name

MAX_INT = 2**53


def sha256(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()


# ---- §2.3 canonical JSON ----------------------------------------------------
# Keys sorted by Unicode code point (Python str comparison is code-point
# order already); minimal escaping; NFC; integers only; UTF-8 output.


def _escape(s: str) -> str:
    out = ['"']
    for ch in s:
        if ch == '"':
            out.append('\\"')
        elif ch == "\\":
            out.append("\\\\")
        elif ord(ch) < 0x20:
            out.append("\\u%04x" % ord(ch))  # C0 controls, lowercase hex
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def canonical(value) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, bool):  # unreachable, but bool is an int subclass
        raise ValueError("unreachable bool")
    if isinstance(value, int):
        if abs(value) > MAX_INT:
            raise ValueError(f"canonical JSON: integer out of range {value}")
        return str(value)
    if isinstance(value, float):
        raise ValueError(f"canonical JSON: floats forbidden: {value}")
    if isinstance(value, str):
        return _escape(unicodedata.normalize("NFC", value))
    if isinstance(value, list):
        return "[" + ",".join(canonical(v) for v in value) + "]"
    if isinstance(value, dict):
        items = []
        for k, v in value.items():
            if not isinstance(k, str):
                raise ValueError("canonical JSON: non-string key")
            items.append((unicodedata.normalize("NFC", k), v))
        items.sort(key=lambda kv: kv[0])
        for i in range(1, len(items)):
            if items[i][0] == items[i - 1][0]:
                raise ValueError(f"canonical JSON: duplicate key after NFC: {items[i][0]!r}")
        return "{" + ",".join(_escape(k) + ":" + canonical(v) for k, v in items) + "}"
    raise ValueError(f"canonical JSON: unsupported type {type(value).__name__}")


def canonical_bytes(value) -> bytes:
    return canonical(value).encode("utf-8")


# ---- §2.1 HKDF-SHA256 (RFC 5869), extract-then-expand, full form ------------


def hkdf_sha256(ikm: bytes, salt: bytes, info: bytes, length: int) -> bytes:
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()  # extract
    okm, t, counter = b"", b"", 1
    while len(okm) < length:  # expand
        t = hmac.new(prk, t + info + bytes([counter]), hashlib.sha256).digest()
        okm += t
        counter += 1
    return okm[:length]


# ---- §2.7–§2.11 lanes, chains, draws ----------------------------------------


def decimal_string(n: int) -> str:
    """Minimal signed decimal: no '+', no leading zeros, '0' for zero."""
    if not isinstance(n, int) or isinstance(n, bool) or abs(n) > MAX_INT:
        raise ValueError(f"decimal_string: not a valid protocol integer: {n}")
    return str(n)


def lane_root(ikm: bytes, slot_id: str, lane_name: str) -> bytes:
    info = (INFO_PREFIX + slot_id + "/" + lane_name).encode("utf-8")
    return hkdf_sha256(ikm, SALT, info, 32)


def genesis_entropy(transcript: dict) -> bytes:
    """Hash only the NFC-normalized active player nonce multiset."""
    nonces = []
    for slot in transcript.get("slots", []):
        if slot.get("status") == "active" and slot.get("role") == "player":
            nonce = slot.get("nonce")
            if not isinstance(nonce, str) or not nonce:
                raise ValueError("every active player needs a non-empty string nonce")
            nonces.append(unicodedata.normalize("NFC", nonce))
    if not nonces:
        raise ValueError("at least one active player nonce is required")
    nonces.sort(key=lambda s: s.encode("utf-8"))
    return sha256(TAG_ENTROPY + canonical_bytes(nonces))


def genesis_configuration(transcript: dict) -> dict:
    """Ceremony choices witnessed before nonces; entropy and time are omitted."""
    return {
        "version": transcript.get("version"),
        "commitment": transcript.get("commitment"),
        "chain_length": transcript.get("chain_length"),
        "campaign": transcript.get("campaign"),
        "context_privacy": transcript.get("context_privacy"),
        "disclosure_policy": transcript.get("disclosure_policy"),
        "check_types": transcript.get("check_types"),
        "slots": [
            {
                "id": s.get("id"), "display": s.get("display"), "role": s.get("role"),
                "status": s.get("status"), "lanes": s.get("lanes"), "nonce": None,
            }
            for s in transcript.get("slots", [])
        ],
        "beacon": transcript.get("beacon"),
    }


def configuration_commitment(transcript: dict) -> str:
    return sha256(TAG_CONFIG + canonical_bytes(genesis_configuration(transcript))).hex()


def label_salt(secret: bytes, entropy: bytes, slot_id: str) -> bytes:
    """§2.8 — IKM is S || E only; A would be circular (it contains label_commit)."""
    info = (INFO_PREFIX + slot_id + LABEL_INFO).encode("utf-8")
    return hkdf_sha256(secret + entropy, SALT, info, 32)


def chain_step(x: bytes) -> bytes:
    return sha256(TAG_CHAIN + x)


def chain_links(root: bytes, n: int) -> list[bytes]:
    """links[0] = root … links[n] = tail."""
    links = [root]
    for _ in range(n):
        links.append(chain_step(links[-1]))
    return links


def preimage_at(links: list[bytes], position: int) -> bytes:
    """§2.11: draw k consumes p_k = link[N − k]."""
    n = len(links) - 1
    if not 1 <= position <= n:
        raise ValueError(f"position {position} out of range 1..{n}")
    return links[n - position]


def roll_from_preimage(p: bytes) -> int:
    """roll = 1 + (int_be(SHA256(TAG_DIE || p)) mod 20). No rejection sampling."""
    return 1 + int.from_bytes(sha256(TAG_DIE + p), "big") % 20


# ---- §2.12 derived salts and commitments ------------------------------------


def salt_dc(p: bytes, seq: int) -> bytes:
    return sha256(TAG_SALT_DC + p + decimal_string(seq).encode())


def salt_mod(p: bytes, seq: int) -> bytes:
    return sha256(TAG_SALT_MOD + p + decimal_string(seq).encode())


def salt_ctx(p: bytes, seq: int) -> bytes:
    return sha256(TAG_SALT_CTX + p + decimal_string(seq).encode())


def dc_commit(p: bytes, seq: int, dc: int) -> str:
    return sha256(TAG_DC + salt_dc(p, seq) + decimal_string(dc).encode()).hex()


def mod_commit(p: bytes, seq: int, modifier: int) -> str:
    return sha256(TAG_MOD + salt_mod(p, seq) + decimal_string(modifier).encode()).hex()


def context_commit(p: bytes, seq: int, context: str) -> str:
    # context is NFC-normalized before hashing (§2.12)
    nfc = unicodedata.normalize("NFC", context)
    return sha256(TAG_CONTEXT + salt_ctx(p, seq) + nfc.encode("utf-8")).hex()


def label_commit(salt: bytes, display: str, role: str) -> str:
    return sha256(TAG_LABEL + salt + canonical_bytes({"display": display, "role": role})).hex()


# ---- §2.14 degree of success ------------------------------------------------


def degree_of_success(roll: int, modifier: int, dc: int) -> int:
    total = roll + modifier
    if total >= dc + 10:
        degree = 3
    elif total >= dc:
        degree = 2
    elif total <= dc - 10:
        degree = 0
    else:
        degree = 1
    if roll == 20:
        degree = min(degree + 1, 3)
    if roll == 1:
        degree = max(degree - 1, 0)
    return degree


def paired_select(rule: str, first: int, second: int) -> int:
    return max(first, second) if rule == "fortune" else min(first, second)


# ---- §3 ledger verification -------------------------------------------------
# Failure message strings are normative for the negative test vectors and
# must be byte-identical to the TypeScript implementation (gm/core/verify.ts).

import re
from datetime import datetime, timezone

ZERO64 = "0" * 64
LEDGER_FORMAT = "wotw-column-ledger/4"
TS_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
LANE_RE = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
PROFILE_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]")
PROFILE_TRIM_CHARS = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680" \
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a" \
    "\u2028\u2029\u202f\u205f\u3000\ufeff"
FORBIDDEN_PROFILE_NAMES = {
    "prototype", "constructor", "__defineGetter__", "__defineSetter__",
    "hasOwnProperty", "__lookupGetter__", "__lookupSetter__", "isPrototypeOf",
    "propertyIsEnumerable", "toString", "valueOf", "__proto__", "toLocaleString",
}


def valid_profile_name(value) -> bool:
    return isinstance(value, str) \
        and value == value.strip(PROFILE_TRIM_CHARS) \
        and 1 <= len(value) <= 64 \
        and PROFILE_CONTROL_RE.search(value) is None \
        and value not in FORBIDDEN_PROFILE_NAMES

# Well-known drand chains (§2.8): recognized hash ⇒ params must match.
KNOWN_CHAINS = {
    "drand:8990e7a9aaed2ffed73dbd7092123d6f289930540d7651336225dc172e51b2ce":
        {"genesis_time": 1595431050, "period": 30},
    "drand:52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971":
        {"genesis_time": 1692803367, "period": 3},
}

REQUIRED_FIELDS = {
    "genesis": ["transcript", "tails"],
    "session-open": [], "session-close": [], "note": ["text"], "reveal-all": ["scope"],
    "announce": ["slot", "lane", "check_type", "initiator"],
    "draw": ["slot", "lane", "position", "check_type", "initiator"],
    "void": ["slot", "lane", "announce_seq", "reason"],
    "correction": ["target_seq", "reason"],
    "dc-late": ["target_seq"],
    "out-of-band": ["check_type", "result", "reason"],
    "disclose": ["slot", "lane", "through_position", "preimage", "opened"],
    "sheet-update": ["slot", "effective_from", "modifiers"],
    "check-type": ["op", "check_type"],
    "activation-declare": ["declaration"],
    "activate": ["activation_record", "tails"],
    "lane-add": ["slot", "lane", "tail"],
    "retire-slot": ["slot", "reason"],
    "final-reveal": ["secret", "labels"],
    "closed": ["reason"],
}

ENTRY_FIELDS = {
    "genesis": ["transcript", "tails"],
    "session-open": [], "session-close": [],
    "announce": ["slot", "lane", "check_type", "initiator", "context", "context_commit",
                 "dc", "dc_commit"],
    "draw": ["slot", "lane", "position", "check_type", "initiator", "modifier",
             "mod_commit", "context", "context_commit", "dc", "dc_commit",
             "announce_seq", "batch", "paired_with", "pair_rule", "gm_degree"],
    "void": ["slot", "lane", "announce_seq", "reason"],
    "correction": ["target_seq", "reason", "replacement_seq"],
    "dc-late": ["target_seq", "dc", "dc_commit"],
    "out-of-band": ["check_type", "slot", "result", "reason"],
    "disclose": ["slot", "lane", "through_position", "preimage", "opened"],
    "sheet-update": ["slot", "effective_from", "modifiers"],
    "check-type": ["op", "check_type"],
    "activation-declare": ["declaration"],
    "activate": ["activation_record", "tails"],
    "lane-add": ["slot", "lane", "tail"],
    "retire-slot": ["slot", "reason"],
    "note": ["text"], "reveal-all": ["scope"],
    "final-reveal": ["secret", "labels"], "closed": ["reason"],
}
COMMON_ENTRY_FIELDS = {"seq", "ts", "session", "kind", "prev", "hash"}


def entry_hash(entry: dict) -> str:
    rest = {k: v for k, v in entry.items() if k != "hash"}
    return sha256(canonical_bytes(rest)).hex()


def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


# JavaScript object lookups with a non-string key simply miss, and JS
# arithmetic coerces junk instead of raising. Python raises on both, so a
# malformed ledger would crash this verifier where the others report a clean
# failure. These helpers keep all three implementations on the same path:
# report the structural failure, then carry a safe placeholder forward.
def _key(v):
    """A hashable stand-in for a possibly-unhashable lookup key."""
    return v if isinstance(v, (str, int, float, bool, type(None))) else _UNHASHABLE


_UNHASHABLE = object()


def _asdict(v) -> dict:
    """The value when it is a mapping, else an empty one."""
    return v if isinstance(v, dict) else {}


def _dget(d, k, default=None):
    """dict.get that tolerates unhashable keys."""
    if not isinstance(d, dict):
        return default
    try:
        return d.get(k, default)
    except TypeError:
        return default


def _int_or(v, fallback: int = 0) -> int:
    """The value when it is a protocol integer, else a safe placeholder."""
    return v if _is_int(v) else fallback


def _str_or(v, fallback: str = "?") -> str:
    return v if isinstance(v, str) else fallback


def _valid_timestamp(v) -> bool:
    if not isinstance(v, str) or not TS_RE.match(v):
        return False
    try:
        return datetime.strptime(v, "%Y-%m-%dT%H:%M:%SZ").strftime("%Y-%m-%dT%H:%M:%SZ") == v
    except ValueError:
        return False


def _valid_date(v) -> bool:
    if not isinstance(v, str) or not re.match(r"^\d{4}-\d{2}-\d{2}$", v):
        return False
    try:
        return datetime.strptime(v, "%Y-%m-%d").strftime("%Y-%m-%d") == v
    except ValueError:
        return False


def verify_ledger(file) -> dict:
    """Check all §3.3 invariants. Returns {verdict, state, failures, entries, rolls}."""
    failures: list[str] = []
    fail = failures.append
    rolls: dict[int, int] = {}

    if not isinstance(file, dict) or not isinstance(file.get("entries"), list):
        return {"verdict": "FAILED", "state": "sealed",
                "failures": ["structure: not a ledger file"], "entries": 0, "rolls": rolls}
    for key in file:
        if key not in ("format", "head", "entries"):
            fail(f"structure: unexpected ledger field {key}")
    if file.get("format") != LEDGER_FORMAT:
        fail(f"structure: format is {file.get('format')}, expected {LEDGER_FORMAT}")
    entries = file["entries"]

    # -- pass 1: structural invariants 1–5 --
    for i, e in enumerate(entries):
        if e.get("seq") != i:
            fail(f"inv 1: entry at index {i} has seq {e.get('seq')}, expected {i}")
        if i == 0:
            if e.get("kind") != "genesis":
                fail(f"inv 2: entry 0 kind is {e.get('kind')}, expected genesis")
        elif e.get("kind") == "genesis":
            fail(f"inv 2: entry {e.get('seq')} is a second genesis")
        expected_prev = ZERO64 if i == 0 else entries[i - 1].get("hash")
        if e.get("prev") != expected_prev:
            fail(f"inv 3: seq {e.get('seq')} prev does not match hash of seq {i - 1}")
        try:
            if entry_hash(e) != e.get("hash"):
                fail(f"inv 4: seq {e.get('seq')} hash does not recompute")
        except ValueError:
            fail(f"inv 4: seq {e.get('seq')} hash does not recompute")
        if not _valid_timestamp(e.get("ts")):
            fail(f"structure: seq {e.get('seq')} bad ts")
        elif i > 0 and isinstance(entries[i - 1].get("ts"), str) and e["ts"] < entries[i - 1]["ts"]:
            fail(f"inv 5: seq {e.get('seq')} ts decreases")
    if entries and file.get("head") != entries[-1].get("hash"):
        fail("structure: head does not match last entry hash")
    if not entries:
        fail("structure: empty ledger")
        return {"verdict": "FAILED", "state": "sealed", "failures": failures,
                "entries": 0, "rolls": rolls}

    # -- semantic state --
    transcript = None
    chain_len = 0
    registry: dict[str, dict] = {}
    slots: dict[str, dict] = {}
    activation_records: dict[str, dict] = {}
    deferred_queue: list[str] = []
    tails: dict[str, str] = {}
    cursor: dict[str, int] = {}
    max_concerned: dict[str, int] = {}
    carriers: dict[str, list] = {}
    draws_by_lane: dict[str, list] = {}
    draw_records: dict[int, dict] = {}
    open_announces: dict[int, dict] = {}
    paired_refs: set[str] = set()
    dc_late_targets: set[int] = set()
    corrected: set[int] = set()
    batches: dict[str, dict] = {}
    watermark: dict[str, int] = {}
    opened_seqs: set[int] = set()
    discloses: list[dict] = []
    pending_sheet_updates: list[dict] = []
    activated_count = 0
    saw_disclose = False
    final_reveal = None
    closed_seq = None
    current_session = 0
    session_open = False
    pending_activation = None

    def bump(k: str, v: int) -> None:
        max_concerned[k] = max(max_concerned.get(k, 0), v)

    def add_carrier(k: str, seq: int, pos: int, commits: dict) -> None:
        # pos feeds chain arithmetic and must be an int (JS coerces, Python
        # raises); seq stays raw so failure messages quote what the ledger said
        pos = _int_or(pos)
        if commits:
            carriers.setdefault(k, []).append({"seq": seq, "pos": pos, "commits": commits})

    def exact_keys(obj, expected: list[str], where: str) -> bool:
        if not isinstance(obj, dict):
            fail(f"structure: {where} is not an object")
            return False
        if sorted(obj) != sorted(expected):
            fail(f"structure: {where} has unexpected or missing fields")
            return False
        return True

    def leak_check(e: dict) -> None:
        for key in e:
            if key in ("link", "result") or "salt" in key:
                fail(f"inv 20: seq {e['seq']} forbidden field {key}")

    def check_typing(e: dict, st):
        # inv-10 family, shared by draw and announce. Returns type or None.
        if st is None:
            fail(f"inv 18: seq {e['seq']} draw for inactive slot {e['slot']}")
            return None
        if st["retired"]:
            fail(f"inv 15: seq {e['seq']} draw for retired slot {e['slot']}")
        elif not st["active"]:
            fail(f"inv 18: seq {e['seq']} draw for inactive slot {e['slot']}")
        type_ = _dget(registry, e.get("check_type"))
        if type_ is None:
            fail(f"inv 10: seq {e['seq']} unknown check_type {e['check_type']}")
            return None
        if e["lane"] != type_["lane"]:
            fail(f"inv 10: seq {e['seq']} lane {e['lane']} does not match "
                 f"check_type {e['check_type']} lane {type_['lane']}")
        if st["lanes"] is not None and _key(e.get("lane")) not in st["lanes"]:
            fail(f"inv 10: seq {e['seq']} slot {e['slot']} does not declare lane {e['lane']}")
        # role is sealed for activated slots — rechecked after final reveal
        if st["role"] is not None and st["role"] not in type_["roles"]:
            fail(f"inv 10: seq {e['seq']} slot role {st['role']} not in roles "
                 f"of check_type {e['check_type']}")
        return type_

    def seal_forms(e: dict, type_: dict) -> None:
        if type_["seal_dc"] and "dc" in e:
            fail(f"seal: seq {e['seq']} field dc form contradicts registry")
        if not type_["seal_dc"] and "dc_commit" in e:
            fail(f"seal: seq {e['seq']} field dc form contradicts registry")
        if type_["seal_modifier"] and "modifier" in e:
            fail(f"seal: seq {e['seq']} field modifier form contradicts registry")
        if not type_["seal_modifier"] and "mod_commit" in e:
            fail(f"seal: seq {e['seq']} field modifier form contradicts registry")
        sealed_ctx = transcript is not None and transcript.get("context_privacy") == "sealed"
        if sealed_ctx and "context" in e:
            fail(f"seal: seq {e['seq']} field context form contradicts registry")
        if not sealed_ctx and "context_commit" in e:
            fail(f"seal: seq {e['seq']} field context form contradicts registry")
        for f in ("dc_commit", "mod_commit", "context_commit"):
            if f in e and (not isinstance(e[f], str) or not HEX64_RE.match(e[f])):
                fail(f"structure: seq {e['seq']} malformed {f}")
        if "dc" in e and not _is_int(e["dc"]):
            fail(f"structure: seq {e['seq']} malformed dc")
        if "modifier" in e and not _is_int(e["modifier"]):
            fail(f"structure: seq {e['seq']} malformed modifier")
        if "context" in e and not isinstance(e["context"], str):
            fail(f"structure: seq {e['seq']} malformed context")

    # -- pass 2: semantic walk --
    for e in entries:
        kind = e.get("kind")
        # dict.get raises on unhashable keys (list/dict) where JS lookups
        # simply miss; normalize so all implementations report the same thing
        req = REQUIRED_FIELDS.get(kind) if isinstance(kind, str) else None
        if req is None:
            fail(f"structure: seq {e.get('seq')} unknown kind "
                 f"{kind if isinstance(kind, str) else '?'}")
            continue
        missing = [f for f in req if f not in e]
        if missing:
            fail(f"structure: seq {e.get('seq')} missing field {missing[0]}")
            continue
        allowed = COMMON_ENTRY_FIELDS | set(ENTRY_FIELDS[kind])
        for field in e:
            if field not in allowed:
                fail(f"structure: seq {e['seq']} unexpected field {field}")
        expected_session = current_session + 1 if kind == "session-open" else current_session
        if not _is_int(e.get("session")) or e["session"] != expected_session:
            fail(f"structure: seq {e['seq']} session {e.get('session')} does not match ledger state")
        if final_reveal is not None and kind != "closed":
            fail(f"structure: seq {e['seq']} entry after final-reveal")
        if pending_activation is not None and kind != "activate":
            fail(f"structure: seq {e['seq']} must complete activation declared at seq "
                 f"{pending_activation['seq']}")

        if kind == "genesis":
            if e["seq"] != 0:
                continue  # second genesis already failed inv 2
            transcript = e["transcript"]
            if not isinstance(transcript, dict):
                fail("structure: genesis transcript missing")
                transcript = None
                continue
            exact_keys(transcript, [
                "version", "commitment", "chain_length", "created_at", "campaign",
                "context_privacy", "disclosure_policy", "check_types", "slots", "beacon",
                "configuration_commitment",
            ], "genesis transcript")
            if not isinstance(transcript.get("commitment"), str) \
                    or not HEX64_RE.match(transcript["commitment"]):
                fail("inv 6: commitment is not 64 lowercase hex")
            if transcript.get("version") != "wotw-column/1":
                fail("structure: unsupported transcript version")
            if not isinstance(transcript.get("campaign"), str) or not transcript["campaign"] \
                    or not isinstance(transcript.get("disclosure_policy"), str) \
                    or not transcript["disclosure_policy"] \
                    or transcript.get("context_privacy") not in ("plain", "sealed") \
                    or not _valid_timestamp(transcript.get("created_at")) \
                    or transcript.get("beacon") is not None:
                fail("structure: malformed genesis transcript metadata")
            # recomputation canonicalizes GM-supplied structure and can raise
            # on malformed input; unhashable can never match
            config_ok = False
            try:
                config_ok = transcript.get("configuration_commitment") \
                    == configuration_commitment(transcript)
            except (ValueError, TypeError, AttributeError):
                config_ok = False
            if not config_ok:
                fail("structure: genesis configuration commitment mismatch")
            chain_len = transcript.get("chain_length", 0)
            if not _is_int(chain_len) or not 1 <= chain_len <= 1_000_000:
                fail("structure: bad chain_length")
                chain_len = 0  # normalized: downstream arithmetic must not diverge
            check_types = transcript.get("check_types")
            if not isinstance(check_types, list) or not check_types:
                fail("structure: genesis check_types missing")
                check_types = []
            for t in check_types:
                fields_ok = exact_keys(
                    t, ["id", "label", "lane", "roles", "seal_dc", "seal_modifier", "ritual"],
                    f"genesis check_type {t.get('id', '') if isinstance(t, dict) else ''}")
                if not fields_ok or not isinstance(t.get("id"), str) \
                        or not re.match(r"^[a-z][a-z0-9-]{0,63}$", t["id"]) \
                        or t["id"] in registry or not isinstance(t.get("label"), str) \
                        or not isinstance(t.get("lane"), str) or not LANE_RE.match(t["lane"]) \
                        or not isinstance(t.get("roles"), list) or not t["roles"] \
                        or any(r not in ("player", "npc", "world") for r in t["roles"]) \
                        or not isinstance(t.get("seal_dc"), bool) \
                        or not isinstance(t.get("seal_modifier"), bool) \
                        or not isinstance(t.get("ritual"), bool):
                    tid = t.get("id") if isinstance(t, dict) else None
                    fail(f"structure: malformed genesis check_type "
                         f"{tid if isinstance(tid, str) else ''}")
                else:
                    registry[t["id"]] = t
            transcript_slots = transcript.get("slots")
            if not isinstance(transcript_slots, list) or not transcript_slots:
                fail("structure: genesis slots missing")
                transcript_slots = []
            for si, s in enumerate(transcript_slots):
                expected_id = f"slot-{si + 1:02d}"
                if not isinstance(s, dict) or s.get("id") != expected_id \
                        or s.get("status") not in ("active", "deferred"):
                    fail(f"structure: genesis slot {si} malformed or out of order")
                    continue
                if s.get("status") == "active":
                    fields_ok = exact_keys(
                        s, ["id", "display", "role", "status", "lanes", "nonce"],
                        f"genesis active slot {s['id']}")
                    if not fields_ok or s.get("role") not in ("player", "npc", "world") \
                            or not isinstance(s.get("display"), str) \
                            or not isinstance(s.get("nonce"), str) or not s["nonce"] \
                            or not isinstance(s.get("lanes"), list) or not s["lanes"] \
                            or len(set(s["lanes"])) != len(s["lanes"]) \
                            or any(not isinstance(lane, str) or not LANE_RE.match(lane)
                                   for lane in s["lanes"]):
                        fail(f"structure: genesis active slot {s['id']} malformed")
                        continue
                    slots[s["id"]] = {"role": s["role"], "lanes": set(s["lanes"]),
                                      "active": True, "retired": False, "A": None}
                    for lane in s["lanes"]:
                        tail = _dget(_asdict(_dget(_asdict(e.get("tails")), _key(s["id"]))), _key(lane))
                        if not isinstance(tail, str) or not HEX64_RE.match(tail):
                            fail(f"structure: genesis missing tail for {s['id']}/{lane}")
                        else:
                            tails[f"{s['id']}/{lane}"] = tail
                else:
                    fields_ok = exact_keys(
                        s, ["id", "display", "role", "status", "lanes", "nonce"],
                        f"genesis deferred slot {s['id']}")
                    if not fields_ok or any(s.get(k) is not None
                                            for k in ("role", "display", "lanes", "nonce")):
                        fail(f"structure: genesis deferred slot {s['id']} is not empty")
                    slots[s["id"]] = {"role": None, "lanes": None,
                                      "active": False, "retired": False, "A": None}
                    deferred_queue.append(s["id"])
            active_slots = [s for s in transcript_slots
                            if isinstance(s, dict) and s.get("status") == "active"]
            if sorted(_asdict(e.get("tails")).keys()) != sorted(s["id"] for s in active_slots):
                fail("structure: genesis tails do not match active slots")
            for s in active_slots:
                lane_keys = sorted(_asdict(_dget(_asdict(e.get("tails")), _key(s["id"]))).keys())
                if not isinstance(s.get("lanes"), list) or lane_keys != sorted(s["lanes"]):
                    fail(f"structure: genesis tails do not match lanes of {s['id']}")
            try:
                genesis_entropy(transcript)
            except (ValueError, TypeError):
                fail("structure: genesis player entropy missing")

        elif kind == "session-open":
            if session_open:
                fail(f"structure: seq {e['seq']} session-open while a session is open")
            current_session = e["session"]
            session_open = True

        elif kind == "session-close":
            if not session_open:
                fail(f"structure: seq {e['seq']} session-close while no session is open")
            session_open = False

        elif kind == "note":
            if not isinstance(e.get("text"), str) or not e["text"].strip():
                fail(f"structure: seq {e['seq']} malformed note")

        elif kind == "reveal-all":
            if not isinstance(e.get("scope"), str) or not e["scope"].strip():
                fail(f"structure: seq {e['seq']} malformed reveal-all")

        elif kind == "sheet-update":
            st = _dget(slots, e.get("slot"))
            if st is None or not st["active"] or st["retired"]:
                fail(f"structure: seq {e['seq']} sheet-update for non-player slot {e['slot']}")
            elif st["role"] is None:
                pending_sheet_updates.append({"seq": e["seq"], "slot": e["slot"]})
            elif st["role"] != "player":
                fail(f"structure: seq {e['seq']} sheet-update for non-player slot {e['slot']}")
            modifiers = e.get("modifiers")
            if not _valid_date(e.get("effective_from")) or not isinstance(modifiers, dict) \
                    or any(not valid_profile_name(name) or not _is_int(value)
                           for name, value in modifiers.items()):
                fail(f"structure: seq {e['seq']} malformed sheet-update")

        elif kind == "check-type":
            fail(f"structure: seq {e['seq']} check-type changes are not supported")

        elif kind == "announce":
            if not session_open:
                fail(f"structure: seq {e['seq']} announce outside an open session")
            if e["initiator"] not in ("gm", "player"):
                fail(f"structure: seq {e['seq']} bad initiator")
            leak_check(e)
            st = _dget(slots, e.get("slot"))
            type_ = check_typing(e, st)
            if type_:
                seal_forms(e, type_)
                if not type_["ritual"]:
                    fail(f"structure: seq {e['seq']} announce for non-ritual "
                         f"check_type {e['check_type']}")
            context_field = "context_commit" if _dget(transcript, "context_privacy") == "sealed" else "context"
            if context_field not in e:
                fail(f"structure: seq {e['seq']} announce missing {context_field}")
            if any(not a["resolved"] for a in open_announces.values()):
                fail(f"structure: seq {e['seq']} announce while another announce is unresolved")
            k = f"{e['slot']}/{e['lane']}"
            reservation = cursor.get(k, 0) + 1
            if reservation > chain_len:
                fail(f"structure: seq {e['seq']} reservation exceeds chain_length")
            bump(k, reservation)
            open_announces[_key(e["seq"])] = {
                "slot": e["slot"], "lane": e["lane"],
                "check_type": e["check_type"], "initiator": e["initiator"],
                "resolved": False,
            }
            commits = {}
            if isinstance(e.get("context_commit"), str):
                commits["context"] = e["context_commit"]
            if isinstance(e.get("dc_commit"), str):
                commits["dc"] = e["dc_commit"]
            add_carrier(k, e["seq"], reservation, commits)

        elif kind == "void":
            if not session_open:
                fail(f"structure: seq {e['seq']} void outside an open session")
            if not isinstance(e.get("reason"), str) or not e["reason"].strip():
                fail(f"structure: seq {e['seq']} malformed void")
            a = _dget(open_announces, e.get("announce_seq"))
            if a is None or a["resolved"] or a["slot"] != e["slot"] or a["lane"] != e["lane"]:
                fail(f"inv 8: seq {e['seq']} announce_seq {e['announce_seq']} does not "
                     f"reference an open announce of {e['slot']}/{e['lane']}")
            else:
                a["resolved"] = True

        elif kind == "draw":
            if not session_open:
                fail(f"structure: seq {e['seq']} draw outside an open session")
            if e["initiator"] not in ("gm", "player"):
                fail(f"structure: seq {e['seq']} bad initiator")
            leak_check(e)
            st = _dget(slots, e.get("slot"))
            type_ = check_typing(e, st)
            if type_:
                seal_forms(e, type_)
                if type_["ritual"] and not _is_int(e.get("announce_seq")):
                    fail(f"structure: seq {e['seq']} ritual draw has no announce_seq")
                mod_field = "mod_commit" if type_["seal_modifier"] else "modifier"
                if mod_field not in e:
                    fail(f"structure: seq {e['seq']} draw missing {mod_field}")
            if "announce_seq" in e and not _is_int(e["announce_seq"]):
                fail(f"structure: seq {e['seq']} bad announce_seq")
            if "batch" in e and (not isinstance(e["batch"], str) or not e["batch"]):
                fail(f"structure: seq {e['seq']} bad batch")
            if "paired_with" in e and not _is_int(e["paired_with"]):
                fail(f"structure: seq {e['seq']} bad paired_with")
            if ("paired_with" in e) != ("pair_rule" in e):
                fail(f"structure: seq {e['seq']} paired_with and pair_rule must appear together")
            if "gm_degree" in e and (not _is_int(e["gm_degree"]) or not 0 <= e["gm_degree"] <= 3):
                fail(f"structure: seq {e['seq']} bad gm_degree")
            k = f"{e['slot']}/{e['lane']}"
            want = cursor.get(k, 0) + 1
            if not _is_int(e["position"]) or not 1 <= e["position"] <= chain_len:
                fail(f"structure: seq {e['seq']} position outside chain_length")
            if e["position"] != want:
                fail(f"inv 7: seq {e['seq']} {e['slot']}/{e['lane']} "
                     f"position {e['position']}, expected {want}")
            pos = _int_or(e["position"])  # placeholder keeps state arithmetic safe
            cursor[k] = pos
            bump(k, pos)
            draws_by_lane.setdefault(k, []).append({"seq": e["seq"], "pos": pos})
            draw_records[_key(e["seq"])] = {
                "slot": e["slot"], "lane": e["lane"], "position": pos,
                "session": e.get("session"), "batch": e.get("batch"),
                "hasDc": "dc" in e or "dc_commit" in e, "checkType": e["check_type"],
            }
            if "announce_seq" in e:
                a = _dget(open_announces, e.get("announce_seq"))
                if a is None or a["resolved"] or a["slot"] != e["slot"] \
                        or a["lane"] != e["lane"] or a["check_type"] != e["check_type"] \
                        or a["initiator"] != e["initiator"]:
                    fail(f"inv 8: seq {e['seq']} announce_seq {e['announce_seq']} does not "
                         f"reference an open announce of "
                         f"{e['slot']}/{e['lane']}/{e['check_type']}/{e['initiator']}")
                else:
                    a["resolved"] = True
            if "batch" in e:
                b = batches.setdefault(_key(e["batch"]), {"seqs": [], "session": e.get("session"),
                                                    "checkType": e["check_type"]})
                b["seqs"].append(e["seq"])
                if b["session"] != e.get("session") or b["checkType"] != e["check_type"]:
                    fail(f"inv 13: batch {e['batch']} not contiguous or mixed session/check_type")
            if "paired_with" in e:
                ref_key = f"{k}#{e['paired_with']}"
                partner = next((d for d in draws_by_lane.get(k, [])
                                if d["pos"] == e["paired_with"] and d["seq"] < e["seq"]), None)
                p_rec = _dget(draw_records, partner["seq"]) if partner else None
                same_group = p_rec is not None and (
                    p_rec["session"] == e.get("session")
                    or (p_rec["batch"] is not None and p_rec["batch"] == e.get("batch")))
                if partner is None or not same_group or ref_key in paired_refs:
                    fail(f"inv 11: seq {e['seq']} invalid paired_with {e['paired_with']}")
                else:
                    paired_refs.add(ref_key)
                    paired_refs.add(f"{k}#{e['position']}")
                if e.get("pair_rule") not in ("fortune", "misfortune"):
                    fail(f"structure: seq {e['seq']} pair_rule {e.get('pair_rule')}")
            commits = {}
            if isinstance(e.get("dc_commit"), str):
                commits["dc"] = e["dc_commit"]
            if isinstance(e.get("mod_commit"), str):
                commits["modifier"] = e["mod_commit"]
            if isinstance(e.get("context_commit"), str):
                commits["context"] = e["context_commit"]
            add_carrier(k, e["seq"], e["position"], commits)

        elif kind == "correction":
            if not isinstance(e.get("reason"), str) or not e["reason"].strip():
                fail(f"structure: seq {e['seq']} malformed correction")
            t = _dget(draw_records, e.get("target_seq"))
            if t is None or e["target_seq"] >= e["seq"] or e["target_seq"] in corrected:
                fail(f"inv 14: seq {e['seq']} invalid correction target {e['target_seq']}")
            else:
                corrected.add(e["target_seq"])
            if "replacement_seq" in e and (e["replacement_seq"] not in draw_records
                    or e["replacement_seq"] == e["target_seq"]
                    or e["replacement_seq"] >= e["seq"]):
                fail(f"inv 14: seq {e['seq']} invalid correction target {e['target_seq']}")

        elif kind == "dc-late":
            if not session_open:
                fail(f"structure: seq {e['seq']} dc-late outside an open session")
            t = _dget(draw_records, e.get("target_seq"))
            if t is None or t["session"] != e.get("session") or t["hasDc"] \
                    or e["target_seq"] in dc_late_targets:
                fail(f"inv 12: seq {e['seq']} invalid dc-late target {e['target_seq']}")
            else:
                dc_late_targets.add(e["target_seq"])
                type_ = _dget(registry, t.get("checkType"))
                if type_:
                    seal_forms(e, type_)
                if isinstance(e.get("dc_commit"), str):
                    add_carrier(f"{t['slot']}/{t['lane']}", e["seq"], t["position"],
                                {"dc": e["dc_commit"]})
                elif not _is_int(e.get("dc")):
                    fail(f"structure: seq {e['seq']} dc-late carries neither dc nor dc_commit")

        elif kind == "out-of-band":
            if e["check_type"] not in registry:
                fail(f"inv 10: seq {e['seq']} unknown check_type {e['check_type']}")
            if "slot" in e and (not isinstance(e["slot"], str) or e["slot"] not in slots):
                fail(f"structure: seq {e['seq']} malformed out-of-band")
            if not _is_int(e.get("result")) or not 1 <= e["result"] <= 20 \
                    or not isinstance(e.get("reason"), str) or not e["reason"]:
                fail(f"structure: seq {e['seq']} malformed out-of-band")
            for key in e:
                if key.endswith("_commit"):
                    fail(f"inv 20: seq {e['seq']} forbidden field {key}")

        elif kind == "activation-declare":
            d = e["declaration"]
            fields_ok = exact_keys(
                d, ["version", "slot", "lanes", "label_commit", "nonce", "declared_at", "beacon"],
                f"seq {e['seq']} activation declaration")
            beacon_ok = isinstance(d, dict) and exact_keys(
                d.get("beacon"), ["chain", "round", "genesis_time", "period"],
                f"seq {e['seq']} activation beacon")
            expected = deferred_queue[activated_count] if activated_count < len(deferred_queue) else None
            if not fields_ok or not beacon_ok or d.get("version") != "wotw-column/1" \
                    or d.get("slot") != expected or not isinstance(d.get("lanes"), list) \
                    or not d["lanes"] or len(set(d["lanes"])) != len(d["lanes"]) \
                    or any(not isinstance(lane, str) or not LANE_RE.match(lane)
                           for lane in d["lanes"]) \
                    or not isinstance(d.get("nonce"), str) or not d["nonce"] \
                    or not isinstance(d.get("label_commit"), str) \
                    or not HEX64_RE.match(d["label_commit"]) \
                    or not isinstance(d.get("beacon"), dict) \
                    or not isinstance(d["beacon"].get("chain"), str) \
                    or not _is_int(d["beacon"].get("round")) or d["beacon"]["round"] < 1 \
                    or not _is_int(d["beacon"].get("genesis_time")) \
                    or d["beacon"]["genesis_time"] < 0 \
                    or not _is_int(d["beacon"].get("period")) or d["beacon"]["period"] < 1 \
                    or not _valid_timestamp(d.get("declared_at")):
                fail(f"structure: seq {e['seq']} malformed activation declaration")
            pending_activation = {"seq": e["seq"], "declaration": d}

        elif kind == "activate":
            if pending_activation is None:
                fail(f"structure: seq {e['seq']} activate has no preceding activation-declare")
            rec = e["activation_record"]
            if not isinstance(rec, dict) or not isinstance(rec.get("slot"), str):
                fail(f"structure: seq {e['seq']} malformed activation_record")
                continue
            exact_keys(rec, ["version", "slot", "lanes", "label_commit", "nonce",
                             "declared_at", "beacon"], f"seq {e['seq']} activation_record")
            exact_keys(rec.get("beacon"), ["chain", "round", "genesis_time", "period",
                                          "randomness"], f"seq {e['seq']} activation beacon")
            expected = deferred_queue[activated_count] if activated_count < len(deferred_queue) else None
            if rec["slot"] != expected:
                fail(f"inv 16: seq {e['seq']} activation targets {rec['slot']}, expected {expected}")
            activated_count += 1
            if pending_activation is not None:
                # canonical() raises on unhashable values (floats, etc.); an
                # unhashable record can never equal the declaration
                declared_matches = False
                try:
                    beacon_without = {k: v for k, v in (rec.get("beacon") or {}).items()
                                      if k != "randomness"}
                    completed_declaration = {**rec, "beacon": beacon_without}
                    declared_matches = canonical_bytes(completed_declaration) == canonical_bytes(
                        pending_activation["declaration"])
                except ValueError:
                    declared_matches = False
                if not declared_matches:
                    fail(f"inv 17: seq {e['seq']} activation_record differs from declaration "
                         f"at seq {pending_activation['seq']}")
            b = rec.get("beacon")
            if not isinstance(b, dict) or not _is_int(b.get("genesis_time")) \
                    or b["genesis_time"] < 0 or not _is_int(b.get("period")) or b["period"] < 1:
                fail(f"inv 17: seq {e['seq']} beacon missing genesis_time/period")
            else:
                if not _is_int(b.get("round")) or b["round"] < 1 \
                        or not isinstance(b.get("chain"), str) \
                        or not isinstance(b.get("randomness"), str) \
                        or not HEX64_RE.match(b["randomness"]):
                    fail(f"inv 17: seq {e['seq']} malformed beacon round/randomness")
                known = KNOWN_CHAINS.get(b.get("chain"))
                if known and (known["genesis_time"] != b["genesis_time"]
                              or known["period"] != b["period"]):
                    fail(f"inv 17: seq {e['seq']} beacon parameters do not match known chain")
                try:
                    declared = datetime.strptime(
                        rec["declared_at"], "%Y-%m-%dT%H:%M:%SZ"
                    ).replace(tzinfo=timezone.utc).timestamp()
                except (ValueError, KeyError, TypeError):
                    fail(f"structure: seq {e['seq']} bad declared_at")
                    declared = None
                if declared is not None:
                    delta = b["genesis_time"] + (b["round"] - 1) * b["period"] - declared
                    if delta < 600:
                        # int() keeps the message identical to the TS side
                        fail(f"inv 17: seq {e['seq']} beacon round publishes "
                             f"{int(delta)}s after declared_at, need >= 600")
            st = _dget(slots, rec.get("slot"))
            if st is not None and not st["active"]:
                lanes = rec.get("lanes")
                if not isinstance(lanes, list) or not lanes or len(set(lanes)) != len(lanes) \
                        or any(not isinstance(lane, str) or not LANE_RE.match(lane)
                               for lane in lanes):
                    fail(f"structure: seq {e['seq']} malformed activation lanes")
                if sorted(_asdict(e.get("tails")).keys()) != sorted(lanes or []):
                    fail(f"structure: seq {e['seq']} activation tails do not match declared lanes")
                st["active"] = True
                st["lanes"] = set(rec.get("lanes", []))
                try:
                    st["A"] = sha256(canonical_bytes(rec))
                except ValueError:
                    fail(f"structure: seq {e['seq']} unhashable activation_record")
                activation_records[rec["slot"]] = rec
                for lane in rec.get("lanes", []):
                    tail = e.get("tails", {}).get(lane)
                    if not isinstance(tail, str) or not HEX64_RE.match(tail):
                        fail(f"structure: seq {e['seq']} missing tail for lane {lane}")
                    else:
                        tails[f"{rec['slot']}/{lane}"] = tail
            pending_activation = None

        elif kind == "lane-add":
            fail(f"structure: seq {e['seq']} lane-add is not supported")

        elif kind == "retire-slot":
            st = _dget(slots, e.get("slot"))
            if st is None or not st["active"] or st["retired"] \
                    or not isinstance(e.get("reason"), str) or not e["reason"].strip():
                fail(f"structure: seq {e['seq']} retire of non-active slot {e['slot']}")
            else:
                st["retired"] = True

        elif kind == "disclose":
            saw_disclose = True
            k = f"{e['slot']}/{e['lane']}"
            tail = tails.get(k)
            if tail is None:
                fail(f"structure: seq {e['seq']} disclose for unknown lane {k}")
                continue
            t = e["through_position"]
            if not _is_int(t) or t < 1 or t > chain_len:
                fail(f"structure: seq {e['seq']} bad through_position")
                continue
            w = watermark.get(k, 0)
            if t <= w:
                fail(f"inv 22: seq {e['seq']} through_position {t} must exceed watermark {w}")
            mc = max_concerned.get(k, 0)
            if t > mc:
                fail(f"inv 22: seq {e['seq']} through_position {t} "
                     f"exceeds highest concerned position {mc}")
            # one forward walk serves the tail check (inv 21), commitment
            # recomputation (inv 24), and derived rolls (inv 23) — O(t)
            chain_ok = False
            walk = None
            if isinstance(e.get("preimage"), str) and HEX64_RE.match(e["preimage"]):
                walk = [bytes.fromhex(e["preimage"])]
                for _ in range(t):
                    walk.append(chain_step(walk[-1]))
                chain_ok = walk[t].hex() == tail
            if not chain_ok:
                fail(f"inv 21: seq {e['seq']} preimage does not reach tail "
                     f"of {e['slot']}/{e['lane']}")

            def p_at(pos: int) -> bytes:
                return walk[t - pos]

            opened = e["opened"] if isinstance(e["opened"], list) else []
            if not isinstance(e["opened"], list):
                fail(f"structure: seq {e['seq']} opened is not an array")
            e_seq = _int_or(e.get("seq"), -1)
            covered = {_key(c["seq"]): c for c in carriers.get(k, [])
                       if _int_or(c["seq"], -1) < e_seq and _int_or(c["pos"]) <= t
                       and _key(c["seq"]) not in opened_seqs}
            last_seq = -1
            for el in opened:
                if not isinstance(el, dict) or not _is_int(el.get("seq")):
                    fail(f"structure: seq {e['seq']} malformed opened element")
                    continue
                if el["seq"] <= last_seq:
                    fail(f"inv 24: seq {e['seq']} opened not sorted ascending")
                last_seq = el["seq"]
                c = covered.pop(_key(el["seq"]), None)
                if c is None:
                    fail(f"inv 24: seq {e['seq']} opened has unexpected seq {el['seq']}")
                    continue
                opened_seqs.add(_key(el["seq"]))
                fields = sorted(f for f in el if f != "seq")
                expect_fields = sorted(c["commits"])
                if fields != expect_fields:
                    fail(f"inv 24: seq {e['seq']} opened {el['seq']} "
                         f"fields do not match commitments")
                    continue
                if chain_ok and walk is not None:
                    p = p_at(c["pos"])
                    for f in expect_fields:
                        ok = False
                        try:
                            if f == "dc":
                                ok = dc_commit(p, c["seq"], el["dc"]) == c["commits"]["dc"]
                            elif f == "modifier":
                                ok = mod_commit(p, c["seq"], el["modifier"]) == c["commits"]["modifier"]
                            elif f == "context":
                                ok = context_commit(p, c["seq"], el["context"]) == c["commits"]["context"]
                        except (ValueError, TypeError):
                            ok = False
                        if not ok:
                            fail(f"inv 24: seq {e['seq']} opened {el['seq']} {f} commitment mismatch")
            for seq_left in covered:
                fail(f"inv 24: seq {e['seq']} opened must include seq "
                     f"{covered[seq_left]['seq']}")
            if chain_ok and walk is not None:
                for d in draws_by_lane.get(k, []):
                    if w < d["pos"] <= t:
                        if _is_int(d["seq"]):
                            rolls[d["seq"]] = roll_from_preimage(p_at(_int_or(d["pos"])))
            watermark[k] = max(w, t)
            discloses.append({"seq": e["seq"], "slot": e["slot"], "lane": e["lane"],
                              "through": t, "preimage": e.get("preimage")})

        elif kind == "final-reveal":
            if session_open:
                fail(f"structure: seq {e['seq']} final-reveal while a session is open")
            if final_reveal is not None:
                fail(f"structure: seq {e['seq']} second final-reveal")
            else:
                final_reveal = e

        elif kind == "closed":
            if not isinstance(e.get("reason"), str) or not e["reason"].strip():
                fail(f"structure: seq {e['seq']} malformed closed")
            if closed_seq is not None:
                fail(f"structure: seq {e['seq']} second closed")
            closed_seq = e["seq"]

    # -- end-of-ledger checks --
    last_seq = entries[-1].get("seq")
    for s, a in open_announces.items():
        if not a["resolved"] and s != last_seq:
            fail(f"inv 9: announce at seq {s} unresolved")
    for bid, b in batches.items():
        if any(s != b["seqs"][i - 1] + 1 for i, s in enumerate(b["seqs"]) if i > 0):
            fail(f"inv 13: batch {bid} not contiguous or mixed session/check_type")
    if closed_seq is not None and closed_seq != last_seq:
        fail("inv 26: closed is not the last entry")
    if closed_seq is not None and final_reveal is None:
        fail("inv 26: closed requires final-reveal")
    if closed_seq is not None and session_open:
        fail("inv 26: closed while a session is open")

    # -- inv 25: final reveal --
    if final_reveal is not None and transcript is not None:
        fr = final_reveal
        secret_ok = False
        S = None
        if isinstance(fr.get("secret"), str) and HEX64_RE.match(fr["secret"]):
            S = bytes.fromhex(fr["secret"])
            secret_ok = sha256(S).hex() == transcript.get("commitment")
        if not secret_ok:
            fail("inv 25: secret does not match commitment")

        labels = fr["labels"] if isinstance(fr.get("labels"), list) else []
        if not isinstance(fr.get("labels"), list):
            fail("inv 25: labels do not cover activations exactly")
        label_slots = [l.get("slot") if isinstance(l, dict) else None for l in labels]
        activated_slots = sorted(activation_records)
        sorted_ok = all(i == 0 or (s is not None and s > label_slots[i - 1])
                        for i, s in enumerate(label_slots))
        if not sorted_ok or sorted(str(s) for s in label_slots) != activated_slots:
            fail("inv 25: labels do not cover activations exactly")

        if secret_ok and S is not None:
            try:
                E = genesis_entropy(transcript)
            except (ValueError, TypeError):
                E = None
            for l in labels:
                if not isinstance(l, dict):
                    continue
                if sorted(l) != ["display", "role", "slot"]:
                    fail(f"inv 25: label for {l.get('slot', '')} does not recompute")
                    continue
                rec = _dget(activation_records, l.get("slot"))
                if rec is None:
                    continue
                if E is None:
                    continue
                salt = label_salt(S, E, l["slot"])
                try:
                    ok = isinstance(l.get("display"), str) and bool(l["display"]) \
                        and l.get("role") in ("player", "npc", "world") \
                        and label_commit(salt, l["display"], l["role"]) == rec.get("label_commit")
                except (ValueError, KeyError, TypeError):
                    ok = False
                if not ok:
                    fail(f"inv 25: label for {l['slot']} does not recompute")
                else:
                    st = _dget(slots, l.get("slot"))
                    if st is not None:
                        st["role"] = l["role"]
                    for seq, d in draw_records.items():
                        if d["slot"] != l["slot"]:
                            continue
                        type_ = _dget(registry, d.get("checkType"))
                        if type_ and l["role"] not in type_["roles"]:
                            fail(f"inv 10: seq {seq} slot role {l['role']} not in roles "
                                 f"of check_type {d['checkType']}")
            for p in pending_sheet_updates:
                if _dget(_dget(slots, p.get("slot"), {}) or {}, "role") != "player":
                    fail(f"structure: seq {p['seq']} sheet-update for non-player slot {p['slot']}")
            # every published tail and every disclosed preimage recomputes from S
            for k, tail_hex in tails.items():
                slot, lane = k.split("/", 1)
                st = _dget(slots, slot)
                A = st["A"] if st else None
                if E is None:
                    continue
                ikm = S + E + A if A else S + E
                links = chain_links(lane_root(ikm, slot, lane), chain_len)
                if links[chain_len].hex() != tail_hex:
                    fail(f"inv 25: tail of {slot}/{lane} does not recompute")
                    continue
                for d in discloses:
                    if d["slot"] != slot or d["lane"] != lane:
                        continue
                    if links[chain_len - d["through"]].hex() != d["preimage"]:
                        fail(f"inv 25: disclosed preimage mismatch for {slot}/{lane}")
                for seq, draw in draw_records.items():
                    # rolls is serialized by --json: only real integer seqs
                    if _is_int(seq) and draw["slot"] == slot and draw["lane"] == lane \
                            and _is_int(draw["position"]) and 1 <= draw["position"] <= chain_len:
                        rolls[seq] = roll_from_preimage(preimage_at(links, draw["position"]))

    state = ("fully revealed" if final_reveal is not None
             else "partially disclosed" if saw_disclose else "sealed")
    return {"verdict": "FAILED" if failures else "VERIFIED", "state": state,
            "failures": failures, "entries": len(entries), "rolls": rolls}


# ---- vector self-check (§9) -------------------------------------------------


class Checker:
    def __init__(self) -> None:
        self.failures: list[str] = []
        self.count = 0

    def check(self, name: str, ok: bool, detail: str = "") -> None:
        self.count += 1
        if not ok:
            self.failures.append(f"{name}{': ' + detail if detail else ''}")


def run_vectors(path: str) -> int:
    with open(path, encoding="utf-8") as f:
        v = json.load(f)
    c = Checker()

    # item 1: canonical JSON
    for case in v["canonical_json"]:
        got = canonical(case["value"])
        c.check(f"canonical: {case['name']}", got == case["canonical"],
                f"got {got!r}")
        c.check(f"canonical sha256: {case['name']}",
                sha256(got.encode()).hex() == case["sha256"])

    # item 2: toy ceremony
    toy = v["toy_ceremony"]
    S = bytes.fromhex(toy["S"])
    transcript = toy["transcript"]
    T = sha256(canonical_bytes(transcript))
    E = genesis_entropy(transcript)
    c.check("toy: transcript hash T", T.hex() == toy["transcript_canonical_sha256"],
            f"got {T.hex()}")
    c.check("toy: genesis entropy", E.hex() == toy["genesis_entropy"], f"got {E.hex()}")
    c.check("toy: configuration commitment",
            configuration_commitment(transcript) == toy["configuration_commitment"])
    c.check("toy: commitment", sha256(S).hex() == transcript["commitment"])
    n = transcript["chain_length"]
    ikm = S + E
    links_cache: dict[tuple[str, str], list[bytes]] = {}
    for lane in toy["lanes"]:
        root = lane_root(ikm, lane["slot"], lane["lane"])
        c.check(f"toy root {lane['slot']}/{lane['lane']}", root.hex() == lane["root"])
        links = chain_links(root, n)
        links_cache[(lane["slot"], lane["lane"])] = links
        c.check(f"toy tail {lane['slot']}/{lane['lane']}", links[n].hex() == lane["tail"])

    # item 3: draws
    for ld in v["draws"]:
        links = links_cache[(ld["slot"], ld["lane"])]
        for d in ld["draws"]:
            p = preimage_at(links, d["position"])
            c.check(f"draw {ld['slot']}/{ld['lane']} #{d['position']} preimage",
                    p.hex() == d["preimage"])
            c.check(f"draw {ld['slot']}/{ld['lane']} #{d['position']} roll",
                    roll_from_preimage(p) == d["roll"])

    # item 4: lane independence
    li = v["lane_independence"]
    c.check("lane independence: roots distinct",
            len(set(li["roots"])) == len(li["roots"]))
    open_links = {x.hex() for x in links_cache[("slot-01", "open")]}
    sealed_links = links_cache[("slot-01", "sealed")]
    disclosed = {preimage_at(sealed_links, k).hex() for k in range(1, 8)}
    c.check("lane independence: sealed disclosure disjoint from open lane",
            not (disclosed & open_links))

    # item 5: prefix disclosure
    pd = v["prefix_disclosure"]
    tail = next(l["tail"] for l in toy["lanes"]
                if l["slot"] == pd["slot"] and l["lane"] == pd["lane"])
    x = bytes.fromhex(pd["preimage"])
    for _ in range(pd["through_position"]):
        x = chain_step(x)
    c.check("prefix disclosure: forward hash reaches tail", x.hex() == tail)
    for d in pd["derived"]:
        q = bytes.fromhex(pd["preimage"])
        for _ in range(pd["through_position"] - d["position"]):
            q = chain_step(q)
        c.check(f"prefix disclosure: derived #{d['position']}",
                q.hex() == d["preimage"] and roll_from_preimage(q) == d["roll"])

    # item 6: degrees
    for d in v["degrees"]:
        got = degree_of_success(d["roll"], d["modifier"], d["dc"])
        c.check(f"degree: roll {d['roll']} mod {d['modifier']} dc {d['dc']}",
                got == d["degree"], f"got {got}, want {d['degree']}")

    # item 7b: salt derivation
    sd = v["salt_derivation"]
    p = bytes.fromhex(sd["preimage"])
    seen = set()
    for case in sd["cases"]:
        c.check(f"salt_dc seq {case['seq']}", salt_dc(p, case["seq"]).hex() == case["salt_dc"])
        c.check(f"salt_mod seq {case['seq']}", salt_mod(p, case["seq"]).hex() == case["salt_mod"])
        c.check(f"salt_ctx seq {case['seq']}", salt_ctx(p, case["seq"]).hex() == case["salt_ctx"])
        seen |= {case["salt_dc"], case["salt_mod"], case["salt_ctx"]}
    c.check("salt derivation: all six distinct", len(seen) == 6)

    # item 7: commitments
    cm = v["commitments"]
    p = bytes.fromhex(cm["preimage"])
    c.check("dc_commit", dc_commit(p, cm["seq"], cm["dc"]) == cm["dc_commit"])
    c.check("mod_commit", mod_commit(p, cm["seq"], cm["modifier"]) == cm["mod_commit"])
    c.check("negative mod_commit",
            mod_commit(p, cm["seq"], cm["negative_modifier"]) == cm["negative_mod_commit"])
    c.check("context_commit", context_commit(p, cm["seq"], cm["context"]) == cm["context_commit"])
    c.check("context_commit NFC",
            context_commit(p, cm["seq"], cm["context_nfc"]) == cm["context_nfc_commit"])
    c.check("context_commit NFC (pre-composed input agrees)",
            context_commit(p, cm["seq"], unicodedata.normalize("NFC", cm["context_nfc"]))
            == cm["context_nfc_commit"])
    lb = cm["label"]
    ls = label_salt(S, E, lb["slot"])
    c.check("label salt", ls.hex() == lb["salt_label"])
    c.check("label_commit", label_commit(ls, lb["display"], lb["role"]) == lb["label_commit"])

    # item 8: paired draws
    for pr in v["paired"]:
        c.check(f"paired {pr['pair_rule']}",
                paired_select(pr["pair_rule"], pr["rolls"][0], pr["rolls"][1]) == pr["selected"])

    # item 9: activation
    act = v["activation"]
    A = sha256(canonical_bytes(act["record"]))
    c.check("activation: A", A.hex() == act["A"], f"got {A.hex()}")
    b = act["record"]["beacon"]
    round_time = b["genesis_time"] + (b["round"] - 1) * b["period"]
    c.check("activation: beacon wait ≥ 600s",
            round_time == act["round_time"]
            and round_time >= act["declared_at_epoch"] + 600)
    act_ikm = S + E + A
    for lane in act["lanes"]:
        root = lane_root(act_ikm, lane["slot"], lane["lane"])
        c.check(f"activation root {lane['slot']}/{lane['lane']}", root.hex() == lane["root"])
        links = chain_links(root, n)
        c.check(f"activation tail {lane['slot']}/{lane['lane']}", links[n].hex() == lane["tail"])
        for d in lane["draws"]:
            q = preimage_at(links, d["position"])
            c.check(f"activation draw {lane['lane']} #{d['position']}",
                    q.hex() == d["preimage"] and roll_from_preimage(q) == d["roll"])
        # activation IKM must differ from a genesis derivation of the same lane
        c.check(f"activation root differs from genesis derivation ({lane['lane']})",
                lane_root(S + E, lane["slot"], lane["lane"]).hex() != lane["root"])

    # item 10: the complete 80-entry ledger
    lv = v["ledger"]
    res = verify_ledger(lv["ledger"])
    c.check("ledger: verdict VERIFIED", res["verdict"] == "VERIFIED",
            "; ".join(res["failures"][:5]))
    c.check("ledger: state fully revealed", res["state"] == "fully revealed", res["state"])
    c.check("ledger: entry count", res["entries"] == lv["entry_count"])
    for er in lv["expected_rolls"]:
        c.check(f"ledger: roll at seq {er['seq']}", res["rolls"].get(er["seq"]) == er["roll"],
                f"got {res['rolls'].get(er['seq'])}, want {er['roll']}")

    # item 11: negative cases with exact failure messages
    for neg in v["negative_ledgers"]:
        nres = verify_ledger(neg["ledger"])
        c.check(f"negative: {neg['name']} fails", nres["verdict"] == "FAILED")
        c.check(f"negative: {neg['name']} message",
                neg["expected_message"] in nres["failures"],
                f"want {neg['expected_message']!r}; got {nres['failures'][:4]}")

    if c.failures:
        print(f"FAILED — {len(c.failures)}/{c.count} checks failed:")
        for f_ in c.failures:
            print(f"  ✗ {f_}")
        return 1
    print(f"OK — all {c.count} vector checks passed")
    return 0


# ---- sanity self-tests (external known answers, run before any verdict) -----


def self_test() -> None:
    assert sha256(b"").hex() == ("e3b0c44298fc1c149afbf4c8996fb924"
                                 "27ae41e4649b934ca495991b7852b855")
    # HKDF-SHA256, RFC 5869 test case 1
    okm = hkdf_sha256(b"\x0b" * 22, bytes.fromhex("000102030405060708090a0b0c"),
                      bytes.fromhex("f0f1f2f3f4f5f6f7f8f9"), 42)
    assert okm.hex() == ("3cb25f25faacd57a90434f64d0362f2a"
                         "2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865")


def main() -> int:
    ap = argparse.ArgumentParser(description="wotw-column/1 verifier")
    ap.add_argument("ledger", nargs="?", help="published ledger.json to verify")
    ap.add_argument("--vectors", metavar="PATH", help="run test vectors and exit")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    args = ap.parse_args()

    self_test()
    if args.vectors:
        return run_vectors(args.vectors)
    if args.ledger:
        with open(args.ledger, encoding="utf-8") as f:
            res = verify_ledger(json.load(f))
        if args.json:
            print(json.dumps(res, indent=2))
        else:
            print(f"{res['verdict']} ({res['state']}) — {res['entries']} entries")
            for msg in res["failures"]:
                print(f"  ✗ {msg}")
        return 0 if res["verdict"] == "VERIFIED" else 1
    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
