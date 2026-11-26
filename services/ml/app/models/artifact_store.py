"""
Versioned model artifact storage & metadata validation for AuctionCraze ML.
"""
import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
import joblib

ARTIFACTS_DIR = Path(__file__).resolve().parents[2] / "artifacts"


def save_model_artifact(
    model_key: str,
    version: str,
    model_obj: Any,
    metadata: Dict[str, Any],
    base_dir: Path = ARTIFACTS_DIR,
) -> Path:
    target_dir = base_dir / model_key / version
    target_dir.mkdir(parents=True, exist_ok=True)

    model_path = target_dir / "model.joblib"
    meta_path = target_dir / "metadata.json"

    joblib.dump(model_obj, model_path)
    meta_copy = dict(metadata)
    meta_copy["artifact_path"] = str(target_dir.relative_to(base_dir.parent)).replace("\\", "/")
    meta_path.write_text(json.dumps(meta_copy, indent=2), encoding="utf-8")
    return target_dir


def list_model_versions(model_key: str, base_dir: Path = ARTIFACTS_DIR) -> List[Dict[str, Any]]:
    key_dir = base_dir / model_key
    if not key_dir.exists():
        return []

    versions: List[Dict[str, Any]] = []
    for sub in sorted(key_dir.iterdir(), reverse=True):
        meta_path = sub / "metadata.json"
        model_path = sub / "model.joblib"
        if sub.is_dir() and meta_path.exists() and model_path.exists():
            try:
                versions.append(json.loads(meta_path.read_text(encoding="utf-8")))
            except Exception:
                continue
    return versions


def load_model_artifact(
    model_key: str,
    version: Optional[str] = None,
    base_dir: Path = ARTIFACTS_DIR,
) -> Tuple[Any, Dict[str, Any]]:
    versions = list_model_versions(model_key, base_dir=base_dir)
    if not versions:
        raise FileNotFoundError(f"No trained artifacts found for model '{model_key}'")

    chosen_meta = None
    if version:
        for m in versions:
            if m.get("version") == version:
                chosen_meta = m
                break
        if chosen_meta is None:
            raise FileNotFoundError(f"Version '{version}' not found for model '{model_key}'")
    else:
        validated = [m for m in versions if m.get("is_validated")]
        chosen_meta = validated[0] if validated else versions[0]

    chosen_ver = chosen_meta["version"]
    model_path = base_dir / model_key / chosen_ver / "model.joblib"
    if not model_path.exists():
        raise FileNotFoundError(f"Missing joblib binary at {model_path}")

    model_obj = joblib.load(model_path)
    return model_obj, chosen_meta
