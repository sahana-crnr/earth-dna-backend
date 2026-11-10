"""Public shape of a user: what the Node `UserEntity` serialised to.

`password`, `resetPasswordToken`, `resetPasswordExpiry`, `passwordChangedAt`,
`authProvider` and `providerUserId` were `@Exclude()`d and never left the
service. Key order follows the entity.
"""

from __future__ import annotations

from typing import Any, Literal

from app.core.time import to_js_iso
from app.models.user import User

AuthProvider = Literal["local", "google", "facebook", "apple"]
SocialProvider = Literal["google", "facebook", "apple"]


def user_view(user: User) -> dict[str, Any]:
    return {
        "id": str(user.id),
        "fullName": user.full_name,
        "email": user.email,
        "country": user.country,
        "countryCode": user.country_code,
        "zipCode": user.zip_code,
        "role": user.role,
        "createdAt": to_js_iso(user.created_at),
        "updatedAt": to_js_iso(user.updated_at),
    }
