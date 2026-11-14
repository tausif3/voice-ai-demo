from dataclasses import dataclass
from os import getenv
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[1] / ".env")


@dataclass(frozen=True)
class Settings:
    frontend_origin: str = getenv("FRONTEND_ORIGIN", "http://localhost:3000")
    openai_api_key: str = getenv("OPENAI_API_KEY", "")
    r2_account_id: str = getenv("R2_ACCOUNT_ID", "")
    r2_bucket_name: str = getenv("R2_BUCKET_NAME", "")
    r2_access_key_id: str = getenv("R2_ACCESS_KEY_ID", "")
    r2_secret_access_key: str = getenv("R2_SECRET_ACCESS_KEY", "")

    @property
    def r2_configured(self) -> bool:
        return all((
            self.r2_account_id,
            self.r2_bucket_name,
            self.r2_access_key_id,
            self.r2_secret_access_key,
        ))
