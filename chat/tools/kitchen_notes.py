"""
Catalog-aware kitchen note suggestions for the optional special-notes prompt.

Managers can shape hints in three ways (no extra schema required):
  1. category — mark accompaniments as "Sides" / "Accompaniments" / "Extras"
  2. description — add "Kitchen hints: extra sambar, less spicy" on a dish row
  3. standalone side items — e.g. a catalog row named "Sambar" (category Sides)
"""

from __future__ import annotations

import re
from typing import Any

from tools.catalog_tools import fetch_menu_items

_SIDE_CATEGORY_RE = re.compile(
    r"\b(sides?|accompaniments?|extras?|add[\s-]?ons?|condiments?|chutneys?)\b",
    re.I,
)
_ACCOMPANIMENT_NAME_RE = re.compile(
    r"\b(sambar|rasam|chutney|raita|salan|salna|kurma|korma|gravy|papad|pickle|curd)\b",
    re.I,
)
_DRINK_KEYWORDS = {
    "juice", "lassi", "buttermilk", "tea", "coffee", "shake", "smoothie", "soda", "water",
}
_KITCHEN_HINTS_RE = re.compile(r"kitchen\s*hints?\s*:\s*([^\n]+)", re.I)


def _notes_names_source(order_text: str, cart: dict | None) -> str:
    if cart:
        return " ".join(
            (line.get("title") or "").strip()
            for line in cart.values()
            if (line.get("title") or "").strip()
        )
    return order_text


def _looks_like_retailer_sku(text: str) -> bool:
    return bool(re.match(r"^[A-Z]\d{2,}$", (text or "").strip()))


def _order_titles_are_unresolved(cart: dict | None) -> bool:
    if not cart:
        return False
    titles = [(line.get("title") or "").strip() for line in cart.values()]
    if not titles:
        return False
    return all(_looks_like_retailer_sku(t) for t in titles)


def _neutral_hint() -> str:
    return (
        "If there's anything the kitchen should know — allergies, preferences, "
        "or how you'd like it prepared — just type it here."
    )


def _format_examples(examples: list[str]) -> str:
    if not examples:
        return _neutral_hint()
    return (
        "A few ideas based on your order:\n"
        + "\n".join(f"• {e}" for e in examples)
    )


def _dedupe_limit(examples: list[str], limit: int = 4) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for ex in examples:
        key = ex.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(ex)
        if len(out) >= limit:
            break
    return out


def _parse_item_kitchen_hints(description: str) -> list[str]:
    if not description:
        return []
    match = _KITCHEN_HINTS_RE.search(description)
    if not match:
        return []
    return [h.strip() for h in match.group(1).split(",") if h.strip()]


def _is_catalog_side(item: dict[str, Any]) -> bool:
    category = (item.get("category") or "").strip()
    name = (item.get("title") or "").strip()
    description = (item.get("description") or "").strip().lower()
    if _SIDE_CATEGORY_RE.search(category):
        return True
    if description.startswith("[side]") or "type:side" in description[:48]:
        return True
    if name and _ACCOMPANIMENT_NAME_RE.search(name.lower()) and len(name.split()) <= 4:
        return True
    return False


def _catalog_lookups(menu: list[dict[str, Any]]) -> tuple[dict[str, dict], dict[str, dict]]:
    by_id: dict[str, dict] = {}
    by_title: dict[str, dict] = {}
    for item in menu:
        rid = (item.get("id") or "").strip().upper()
        title = (item.get("title") or "").strip().lower()
        if rid:
            by_id[rid] = item
        if title:
            by_title[title] = item
    return by_id, by_title


def _ordered_catalog_items(cart: dict | None, menu: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not cart:
        return []
    by_id, by_title = _catalog_lookups(menu)
    matched: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item_id, line in cart.items():
        rid = (item_id or "").strip().upper()
        title = (line.get("title") or "").strip().lower()
        item = by_id.get(rid) or by_title.get(title)
        if not item:
            continue
        key = (item.get("id") or item.get("title") or "").strip().lower()
        if key in seen:
            continue
        seen.add(key)
        matched.append(item)
    return matched


def _keyword_supplements(names_lower: str, *, skip_side_phrases: bool) -> list[str]:
    """Prep/spice/drink prefs — never generic sides when catalog already supplied them."""
    examples: list[str] = []
    has_drink = any(k in names_lower for k in _DRINK_KEYWORDS)
    has_food = any(
        k in names_lower
        for k in (
            "idli", "dosa", "uttapam", "vada", "parotta", "kothu", "curry",
            "biryani", "biriyani", "rice", "pizza", "burger", "noodles", "chicken", "paneer",
        )
    )

    if not skip_side_phrases:
        if any(k in names_lower for k in ("idli", "dosa", "uttapam", "vada", "medu vada")):
            examples.append("extra sambar or chutney")
        if any(k in names_lower for k in ("biryani", "biriyani", "pulao", "fried rice")):
            examples.append("extra raita")
        if "parotta" in names_lower or "kothu" in names_lower:
            examples.append("salna or kurma on the side")

    if has_food and not (has_drink and not has_food):
        examples.append("less spicy / medium / extra spicy")
    if has_drink:
        if "coffee" in names_lower or "tea" in names_lower:
            examples.append("less sugar / extra hot")
        else:
            examples.append("less sugar / no ice")

    return examples


async def build_notes_hint(
    order_text: str,
    cart: dict | None = None,
    restaurant_id: str | None = None,
) -> str:
    """Build optional kitchen-note suggestions from catalog data, with keyword fallback."""
    names_source = _notes_names_source(order_text, cart)
    if not names_source.strip() or _order_titles_are_unresolved(cart):
        return _neutral_hint()

    names_lower = names_source.lower()
    ordered_titles = {
        (line.get("title") or "").strip().lower()
        for line in (cart or {}).values()
        if (line.get("title") or "").strip()
    }

    examples: list[str] = []
    catalog_side_names: list[str] = []

    if restaurant_id:
        menu = await fetch_menu_items(restaurant_id)
        if menu:
            for item in _ordered_catalog_items(cart, menu):
                examples.extend(_parse_item_kitchen_hints(item.get("description", "")))

            for item in menu:
                if not _is_catalog_side(item):
                    continue
                side_name = (item.get("title") or "").strip()
                if not side_name or side_name.lower() in ordered_titles:
                    continue
                catalog_side_names.append(side_name)
                examples.append(f"extra {side_name}")

    skip_side_phrases = bool(catalog_side_names)
    examples.extend(_keyword_supplements(names_lower, skip_side_phrases=skip_side_phrases))
    return _format_examples(_dedupe_limit(examples))
