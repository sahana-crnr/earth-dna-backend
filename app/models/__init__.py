"""All ORM models. Importing this module registers every table on `Base.metadata`."""

from app.models.base import ALL_ENUMS, Base
from app.models.catalog import (
    CatalogBrand,
    CatalogBrandSubcategory,
    CatalogCategory,
    CatalogProduct,
    CatalogShoeType,
    CatalogSize,
    CatalogSubcategory,
    ConditionMapping,
)
from app.models.integration import NODE_MIGRATIONS, Integration, TypeOrmMigration
from app.models.scan import Scan, ScanPhoto, ScanShoe, ScanShoeResult
from app.models.shoe import Shoe, ShoeFeedback, ShoePhoto, ShoeShare
from app.models.user import RefreshToken, User

__all__ = [
    "ALL_ENUMS",
    "Base",
    "CatalogBrand",
    "CatalogBrandSubcategory",
    "CatalogCategory",
    "CatalogProduct",
    "CatalogShoeType",
    "CatalogSize",
    "CatalogSubcategory",
    "ConditionMapping",
    "NODE_MIGRATIONS",
    "Integration",
    "RefreshToken",
    "Scan",
    "ScanPhoto",
    "ScanShoe",
    "ScanShoeResult",
    "Shoe",
    "ShoeFeedback",
    "ShoePhoto",
    "ShoeShare",
    "TypeOrmMigration",
    "User",
]
