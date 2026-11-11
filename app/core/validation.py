"""Request validation that reports exactly what class-validator reported.

The app was built against NestJS `ValidationPipe({whitelist, forbidNonWhitelisted,
transform, transformOptions: {enableImplicitConversion: true}})`. Its 400 body
is a *list* of sentences, in a fixed order:

  1. one `property X should not exist` per unknown key, in body order;
  2. then each declared field, in declaration order;
  3. inside a field, the validators' messages in **reverse** decorator order
     (class-validator runs the decorators bottom-up), and *all* failing
     validators are reported, not only the first;
  4. an optional field (`@IsOptional`) with `null`/missing skips every rule;
  5. before the rules run, class-transformer applies the field's declared
     primitive type (`String(v)`, `Number(v)`, `Boolean(v)` — so `password: 5`
     becomes `"5"` and passes `@IsString`), then `@Transform` decorators
     (for example NormalizeEmail).

Pydantic cannot be bent into that shape, so a schema here is a small ordered
spec. Field specs are written in the same order as the Node DTO so a route
can be ported line for line, and the goldens pin the output.
"""

from __future__ import annotations

import json
import math
import re
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal, TypeVar

from fastapi import Request
from pydantic import BaseModel, ValidationError

from app.core.errors import ApiError, ValidationFailed

Rule = Callable[[str, Any], str | None]
Transform = Callable[[Any], Any]
Kind = Literal["string", "number", "boolean", "any"]

MISSING: Any = object()


# ─── class-transformer implicit conversion ───────────────────────────────────
def js_string(v: Any) -> Any:
    """`String(v)` for the values JSON can carry; null/undefined pass through."""
    if v is None or v is MISSING or isinstance(v, str):
        return v
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        return js_number_string(v)
    if isinstance(v, list):
        return ",".join("" if x is None else str(js_string(x)) for x in v)
    if isinstance(v, dict):
        return "[object Object]"
    return str(v)


def js_number_string(f: float) -> str:
    if math.isnan(f):
        return "NaN"
    if math.isinf(f):
        return "Infinity" if f > 0 else "-Infinity"
    if f.is_integer() and abs(f) < 1e21:
        return str(int(f))
    return repr(f)


def js_number(v: Any) -> Any:
    """`Number(v)`; null/undefined pass through, unparsable → NaN."""
    if v is None or v is MISSING:
        return v
    if isinstance(v, bool):
        return 1 if v else 0
    if isinstance(v, int | float):
        return v
    if isinstance(v, str):
        s = v.strip()
        if s == "":
            return 0
        if re.fullmatch(r"[+-]?\d+", s):
            return int(s)
        if re.fullmatch(r"0[xX][0-9a-fA-F]+", s):
            return int(s, 16)
        try:
            return float(s)
        except ValueError:
            return math.nan
    if isinstance(v, list):
        if len(v) == 0:
            return 0
        if len(v) == 1:
            return js_number(v[0])
        return math.nan
    return math.nan


def js_boolean(v: Any) -> Any:
    """`Boolean(v)`; note `"false"` is a non-empty string → true (the Nest gotcha)."""
    if v is None or v is MISSING:
        return v
    if isinstance(v, bool):
        return v
    if isinstance(v, int | float):
        return not (v == 0 or (isinstance(v, float) and math.isnan(v)))
    if isinstance(v, str):
        return v != ""
    return True


_COERCE: dict[Kind, Transform] = {
    "string": js_string,
    "number": js_number,
    "boolean": js_boolean,
    "any": lambda v: v,
}


# ─── rules: each returns a message or None (name = property name) ────────────
def is_string(message: str | None = None) -> Rule:
    def rule(name: str, v: Any) -> str | None:
        return None if isinstance(v, str) else (message or f"{name} must be a string")

    return rule


def is_not_empty(message: str | None = None) -> Rule:
    def rule(name: str, v: Any) -> str | None:
        empty = (
            v is None
            or v is MISSING
            or v == ""
            or (isinstance(v, float) and math.isnan(v))
        )
        return (message or f"{name} should not be empty") if empty else None

    return rule


_EMAIL = re.compile(
    r"^(?!\.)(?!.*\.\.)[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}(?<!\.)"
    r"@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
    r"(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$"
)


def is_email(message: str | None = None) -> Rule:
    def rule(name: str, v: Any) -> str | None:
        ok = isinstance(v, str) and len(v) <= 254 and bool(_EMAIL.match(v))
        return None if ok else (message or f"{name} must be an email")

    return rule


def min_length(n: int, message: str | None = None) -> Rule:
    def rule(name: str, v: Any) -> str | None:
        if isinstance(v, str) and len(v) >= n:
            return None
        return message or f"{name} must be longer than or equal to {n} characters"

    return rule


def max_length(n: int, message: str | None = None) -> Rule:
    def rule(name: str, v: Any) -> str | None:
        if isinstance(v, str) and len(v) <= n:
            return None
        return message or f"{name} must be shorter than or equal to {n} characters"

    return rule


def is_uuid(version: int | None = 4, message: str | None = None) -> Rule:
    def rule(name: str, v: Any) -> str | None:
        ok = False
        if isinstance(v, str):
            try:
                parsed = uuid.UUID(v)
                ok = version is None or parsed.version == version
            except ValueError:
                ok = False
        return None if ok else (message or f"{name} must be a UUID")

    return rule


def is_in(values: Sequence[Any], message: str | None = None) -> Rule:
    def rule(name: str, v: Any) -> str | None:
        if v in values:
            return None
        listed = ", ".join(str(x) for x in values)
        return message or f"{name} must be one of the following values: {listed}"

    return rule


def is_int(message: str | None = None) -> Rule:
    def rule(name: str, v: Any) -> str | None:
        ok = (isinstance(v, int) and not isinstance(v, bool)) or (
            isinstance(v, float) and v.is_integer()
        )
        return None if ok else (message or f"{name} must be an integer number")

    return rule


def is_number(message: str | None = None) -> Rule:
    def rule(name: str, v: Any) -> str | None:
        ok = isinstance(v, int | float) and not isinstance(v, bool)
        ok = ok and not (isinstance(v, float) and (math.isnan(v) or math.isinf(v)))
        return (
            None
            if ok
            else (
                message
                or f"{name} must be a number conforming to the specified constraints"
            )
        )

    return rule


def min_value(n: float, message: str | None = None) -> Rule:
    def rule(name: str, v: Any) -> str | None:
        ok = isinstance(v, int | float) and not isinstance(v, bool) and v >= n
        return None if ok else (message or f"{name} must not be less than {n:g}")

    return rule


def max_value(n: float, message: str | None = None) -> Rule:
    def rule(name: str, v: Any) -> str | None:
        ok = isinstance(v, int | float) and not isinstance(v, bool) and v <= n
        return None if ok else (message or f"{name} must not be greater than {n:g}")

    return rule


def is_boolean(message: str | None = None) -> Rule:
    def rule(name: str, v: Any) -> str | None:
        return (
            None
            if isinstance(v, bool)
            else (message or f"{name} must be a boolean value")
        )

    return rule


def is_array(message: str | None = None) -> Rule:
    def rule(name: str, v: Any) -> str | None:
        return None if isinstance(v, list) else (message or f"{name} must be an array")

    return rule


def array_min_size(n: int, message: str | None = None) -> Rule:
    def rule(name: str, v: Any) -> str | None:
        ok = isinstance(v, list) and len(v) >= n
        return None if ok else (message or f"{name} must contain at least {n} elements")

    return rule


def array_max_size(n: int, message: str | None = None) -> Rule:
    def rule(name: str, v: Any) -> str | None:
        ok = isinstance(v, list) and len(v) <= n
        return (
            None
            if ok
            else (message or f"{name} must contain no more than {n} elements")
        )

    return rule


def is_object(message: str | None = None) -> Rule:
    def rule(name: str, v: Any) -> str | None:
        return None if isinstance(v, dict) else (message or f"{name} must be an object")

    return rule


def matches(pattern: str, message: str | None = None) -> Rule:
    rx = re.compile(pattern)

    def rule(name: str, v: Any) -> str | None:
        ok = isinstance(v, str) and bool(rx.search(v))
        return (
            None
            if ok
            else (message or f"{name} must match {pattern} regular expression")
        )

    return rule


def custom(check: Callable[[Any], bool], message: str) -> Rule:
    def rule(name: str, v: Any) -> str | None:
        return None if check(v) else message

    return rule


# ─── transforms (class-transformer @Transform equivalents) ──────────────────
def trim(v: Any) -> Any:
    return v.strip() if isinstance(v, str) else v


def normalize_email(v: Any) -> Any:
    """`@NormalizeEmail()`: trim + lower-case (src/common/decorators)."""
    return v.strip().lower() if isinstance(v, str) else v


# ─── spec ────────────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class FieldSpec:
    name: str
    rules: Sequence[Rule] = ()
    optional: bool = False
    transforms: Sequence[Transform] = ()
    # declared TypeScript type of the property, drives implicit conversion
    kind: Kind = "string"
    # `@ValidateNested` objects: these specs run against the nested dict, or
    # against every item when the value is an array (`{ each: true }`)
    nested: Sequence[FieldSpec] | None = None
    # `@IsString({ each: true })` style rules: run on every array item
    each_rules: Sequence[Rule] = ()
    # `@IsOptional` skips null and undefined; `@ValidateIf(v => v !== undefined)`
    # skips undefined only — set skip_null=False for that shape
    skip_null: bool = True

    def transformed(self, value: Any) -> Any:
        if self.nested is not None or self.each_rules:
            v = (
                [_COERCE[self.kind](x) for x in value]
                if isinstance(value, list)
                else value
            )
        else:
            v = _COERCE[self.kind](value)
        for t in self.transforms:
            v = t(v)
        return v

    def check(self, value: Any, prefix: str = "") -> list[str]:
        v = self.transformed(value)
        if self.optional and (v is MISSING or (v is None and self.skip_null)):
            return []
        name = prefix + self.name
        out: list[str] = []
        # class-validator runs decorators bottom-up: last declared first
        for rule in reversed(self.rules):
            msg = rule(name, v)
            if msg:
                out.append(msg)
        if self.each_rules:
            items = v if isinstance(v, list) else [v]
            for item in items:
                for rule in reversed(self.each_rules):
                    msg = rule(f"each value in {name}", item)
                    if msg:
                        out.append(msg)
        if self.nested is not None:
            items = v if isinstance(v, list) else [v]
            for i, item in enumerate(items):
                if isinstance(item, dict):
                    child = f"{name}.{i}." if isinstance(v, list) else f"{name}."
                    out.extend(validate_dict(item, self.nested, prefix=child))
                else:
                    # class-validator nestedValidation on a non-object element
                    out.append(f"nested property {name} must be either object or array")
        return out


@dataclass
class Schema:
    fields: Sequence[FieldSpec]
    whitelist: bool = True
    known: frozenset[str] = field(init=False)

    def __post_init__(self) -> None:
        self.known = frozenset(f.name for f in self.fields)


def validate_dict(
    data: Mapping[str, Any],
    fields: Sequence[FieldSpec],
    *,
    whitelist: bool = True,
    prefix: str = "",
) -> list[str]:
    messages: list[str] = []
    known = {f.name for f in fields}
    if whitelist:
        for key in data:
            if key not in known:
                messages.append(f"property {prefix}{key} should not exist")
    for spec in fields:
        value = data.get(spec.name, MISSING)
        messages.extend(spec.check(value, prefix))
    return messages


def apply_transforms(
    data: Mapping[str, Any], fields: Sequence[FieldSpec]
) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for spec in fields:
        if spec.name in data:
            v = spec.transformed(data[spec.name])
            if v is not MISSING:
                out[spec.name] = v
    return out


M = TypeVar("M", bound=BaseModel)


def validate_into(data: Mapping[str, Any], schema: Schema, model: type[M]) -> M:
    """Run the class-validator rules, then build the typed Pydantic model."""
    messages = validate_dict(data, schema.fields, whitelist=schema.whitelist)
    if messages:
        raise ValidationFailed(messages)
    clean = apply_transforms(data, schema.fields)
    try:
        return model.model_validate(clean)
    except ValidationError as exc:  # a rule was missing — keep the 400 contract
        fields = sorted({str(e["loc"][0]) for e in exc.errors() if e.get("loc")})
        raise ValidationFailed(
            [f"{f} is invalid" for f in fields] or ["Bad Request"]
        ) from exc


# ─── request helpers ─────────────────────────────────────────────────────────
def _reject_constant(name: str) -> Any:
    raise ValueError(f"{name} is not valid JSON")


async def read_json_body(request: Request) -> dict[str, Any]:
    """Express `body-parser`: no body → {}; malformed JSON → 400 with the parser text."""
    raw = await request.body()
    if not raw.strip():
        return {}
    try:
        parsed = json.loads(raw, parse_constant=_reject_constant)
    except json.JSONDecodeError as exc:
        # V8's wording cannot be reproduced; status and shape are the same.
        raise ApiError(400, None, exc.msg + f" in JSON at position {exc.pos}") from exc
    except (ValueError, RecursionError) as exc:
        # invalid UTF-8, NaN/Infinity (JSON.parse rejects them too), absurd nesting
        raise ApiError(400, None, "Unexpected token in JSON") from exc
    if not isinstance(parsed, dict):
        # class-validator on a non-object body: every field is "missing"
        return {}
    return parsed


def body_of(schema: Schema, model: type[M]) -> Callable[[Request], Any]:
    async def dependency(request: Request) -> M:
        data = await read_json_body(request)
        return validate_into(data, schema, model)

    return dependency


def query_of(schema: Schema, model: type[M]) -> Callable[[Request], Any]:
    def dependency(request: Request) -> M:
        data = dict(request.query_params.items())
        return validate_into(data, schema, model)

    return dependency
