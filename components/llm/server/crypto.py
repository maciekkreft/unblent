"""Encrypt the account's API key at rest (architecture.md 7.7): the key lives only
as ciphertext in llm's store and is never sent back to the browser. The Fernet key
is derived from SESSION_SECRET and a fixed label, so no new .env entry is needed;
rotating SESSION_SECRET makes stored keys unreadable, which is treated as no key.
"""

import base64
import hashlib
import os

from cryptography.fernet import Fernet, InvalidToken


def _fernet() -> Fernet:
    secret = os.environ.get("SESSION_SECRET")
    if not secret:
        # Fail loudly rather than derive a key from "" (as server.user does).
        raise RuntimeError("SESSION_SECRET is not set")
    material = hashlib.sha256(b"unblent-llm-keys:" + secret.encode()).digest()
    return Fernet(base64.urlsafe_b64encode(material))


def encrypt(plaintext: str) -> str:
    return _fernet().encrypt(plaintext.encode()).decode()


def decrypt(ciphertext: str) -> str | None:
    """The stored key, or None when it cannot be read: a rotated SESSION_SECRET
    leaves old ciphertext undecipherable, and the account then has no usable key."""
    try:
        return _fernet().decrypt(ciphertext.encode()).decode()
    except InvalidToken:
        return None
