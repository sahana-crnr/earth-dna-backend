"""Catalog query strings (src/catalog/dto/catalog-query.dto.ts)."""

from __future__ import annotations

import uuid

from pydantic import BaseModel, ConfigDict

from app.core.validation import FieldSpec, Schema, is_string, is_uuid, max_length


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class BrandsQuery(Strict):
    q: str | None = None


BRANDS_QUERY = Schema([FieldSpec("q", [is_string(), max_length(50)], optional=True)])


class SizesQuery(Strict):
    brandId: uuid.UUID | None = None


SIZES_QUERY = Schema([FieldSpec("brandId", [is_uuid(4)], optional=True)])


class ModelsQuery(Strict):
    brandId: uuid.UUID
    q: str | None = None


MODELS_QUERY = Schema(
    [
        FieldSpec("brandId", [is_uuid(4)]),
        FieldSpec("q", [is_string(), max_length(50)], optional=True),
    ]
)


class ColoursQuery(Strict):
    brandId: uuid.UUID
    model: str | None = None


COLOURS_QUERY = Schema(
    [
        FieldSpec("brandId", [is_uuid(4)]),
        FieldSpec("model", [is_string(), max_length(200)], optional=True),
    ]
)
