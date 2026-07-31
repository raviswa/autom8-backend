# chat/agents/supply/nlp_order_parser.py
# ============================================================================
# Munafe Supply (B2B) — free-text WhatsApp order parsing.
#
# Fast path: deterministic qty/unit extraction + fuzzy catalog match.
# LLM fallback (gemini-2.0-flash via google-genai): only for low-confidence
# segments. Does NOT import from chat/agents/customer/* — Gemini client
# setup is copied from the same pattern used there.
# ============================================================================

from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import asdict, dataclass, field
from difflib import SequenceMatcher
from typing import Any, Optional

import httpx

from config.settings import settings

logger = logging.getLogger(__name__)

HIGH_CONFIDENCE = 0.80
LOW_CONFIDENCE = 0.55
AMBIGUITY_GAP = 0.05

# Units accepted in free text (validated against catalog item unit after match).
_UNIT_ALIASES: dict[str, str] = {
    'kg': 'kg', 'kgs': 'kg', 'kilo': 'kg', 'kilos': 'kg', 'kilogram': 'kg', 'kilograms': 'kg',
    'g': 'g', 'gm': 'g', 'gms': 'g', 'gram': 'g', 'grams': 'g',
    'litre': 'litre', 'liter': 'litre', 'litres': 'litre', 'liters': 'litre', 'l': 'litre',
    'ml': 'ml',
    'dozen': 'dozen', 'dz': 'dozen', 'doz': 'dozen',
    'piece': 'piece', 'pcs': 'piece', 'pc': 'piece', 'pieces': 'piece',
    'bunch': 'bunch',
    'bag': 'bag', 'bags': 'bag',
    'crate': 'crate', 'crates': 'crate',
    'sack': 'sack', 'sacks': 'sack',
    'packet': 'pack', 'packets': 'pack', 'pkt': 'pack', 'pkts': 'pack',
    'pack': 'pack', 'packs': 'pack',
    'carton': 'carton', 'cartons': 'carton',
    'box': 'box', 'boxes': 'box',
    'set': 'set', 'sets': 'set',
    'roll': 'roll', 'rolls': 'roll',
    # Hinglish / Hindi common
    'किलो': 'kg', 'किलोग्राम': 'kg', 'ग्राम': 'g', 'लीटर': 'litre',
    'दर्जन': 'dozen', 'पैकेट': 'pack', 'बैग': 'bag', 'पीस': 'piece',
}

_UNIT_ALT = '|'.join(
    sorted((re.escape(k) for k in _UNIT_ALIASES), key=len, reverse=True)
)

# "10 packet chai" / "2kg tomato" / "2 kg tomato"
_QTY_UNIT_ITEM = re.compile(
    rf'(?i)^\s*(?P<qty>\d+(?:\.\d+)?)\s*(?P<unit>{_UNIT_ALT})?\s+(?P<item>.+?)\s*$'
)
# "2kg tomato" glued unit
_QTY_GLUED_UNIT_ITEM = re.compile(
    rf'(?i)^\s*(?P<qty>\d+(?:\.\d+)?)(?P<unit>{_UNIT_ALT})\s+(?P<item>.+?)\s*$'
)
# "chai 10 packet" / "tomato 2kg"
_ITEM_QTY_UNIT = re.compile(
    rf'(?i)^\s*(?P<item>.+?)\s+(?P<qty>\d+(?:\.\d+)?)\s*(?P<unit>{_UNIT_ALT})?\s*$'
)
_ITEM_QTY_GLUED = re.compile(
    rf'(?i)^\s*(?P<item>.+?)\s+(?P<qty>\d+(?:\.\d+)?)(?P<unit>{_UNIT_ALT})\s*$'
)

_SPLIT_RE = re.compile(
    r'(?:,|/|&|\n|\baur\b|\band\b|\bplus\b|\bभी\b|और|तथा)',
    re.IGNORECASE,
)

_HAS_QTY_RE = re.compile(r'\d+(?:\.\d+)?')


@dataclass
class ParsedLine:
    catalog_item_id: Optional[str]
    matched_name: Optional[str]
    quantity: float
    unit: Optional[str]
    confidence: float
    raw_segment: str = ''
    source: str = 'fast'  # fast | llm | unmatched


@dataclass
class ParseResult:
    matched: list[ParsedLine] = field(default_factory=list)
    unmatched: list[str] = field(default_factory=list)
    ambiguous: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            'matched': [asdict(m) for m in self.matched],
            'unmatched': list(self.unmatched),
            'ambiguous': list(self.ambiguous),
        }

    @property
    def all_high_confidence(self) -> bool:
        if not self.matched or self.unmatched or self.ambiguous:
            return False
        return all(
            m.catalog_item_id and m.confidence >= HIGH_CONFIDENCE
            for m in self.matched
        )

    @property
    def avg_confidence(self) -> float:
        if not self.matched:
            return 0.0
        return sum(m.confidence for m in self.matched) / len(self.matched)


def looks_like_order(text: str) -> bool:
    """
    Cheap gate: at least one segment must yield qty+item via the
    deterministic extractor. Avoids treating payment claims like
    'paid 5000 gpay' as orders (those still match _PAYMENT_RE first).
    """
    cleaned = (text or '').strip()
    if not cleaned or not _HAS_QTY_RE.search(cleaned):
        return False
    for seg in _split_segments(cleaned):
        if _extract_qty_unit_item(seg):
            return True
    return False


def _normalize_unit(unit: Optional[str]) -> Optional[str]:
    if not unit:
        return None
    key = unit.strip().lower()
    return _UNIT_ALIASES.get(key) or _UNIT_ALIASES.get(unit.strip()) or key


def _split_segments(text: str) -> list[str]:
    parts = [p.strip() for p in _SPLIT_RE.split(text) if p and p.strip()]
    return parts or [text.strip()]


def _extract_qty_unit_item(segment: str) -> Optional[dict[str, Any]]:
    for pattern in (
        _QTY_GLUED_UNIT_ITEM,
        _QTY_UNIT_ITEM,
        _ITEM_QTY_GLUED,
        _ITEM_QTY_UNIT,
    ):
        m = pattern.match(segment)
        if not m:
            continue
        qty = float(m.group('qty'))
        if qty <= 0:
            continue
        item = (m.group('item') or '').strip()
        # Strip trailing filler verbs (bhej do, chahiye, …)
        item = re.sub(
            r'(?i)\b(bhej(?:\s*do)?|bhejo|chahiye|chahie|please|pls|send|'
            r'do|dena|dijiye|diyo|karo|bhi|भी|करो|भेज|दो|चाहिए)\b.*$',
            '',
            item,
        ).strip(' .,;-')
        # Trailing unit word: "5 atta bags" → item=atta, unit=bag
        unit = _normalize_unit(m.groupdict().get('unit'))
        trailing = re.match(
            rf'(?i)^(?P<item>.+?)\s+(?P<unit>{_UNIT_ALT})\s*$',
            item,
        )
        if trailing and not unit:
            item = trailing.group('item').strip()
            unit = _normalize_unit(trailing.group('unit'))
        if not item:
            continue
        return {
            'quantity': qty,
            'unit': unit,
            'item_phrase': item,
            'raw': segment,
        }
    return None


def _norm_name(s: str) -> str:
    s = (s or '').lower().strip()
    s = re.sub(r'[^a-z0-9\u0900-\u097f\s]', ' ', s)
    s = re.sub(r'\s+', ' ', s).strip()
    return s


def _similarity(a: str, b: str) -> float:
    na, nb = _norm_name(a), _norm_name(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    if na in nb or nb in na:
        return max(0.88, SequenceMatcher(None, na, nb).ratio())
    return SequenceMatcher(None, na, nb).ratio()


def _fuzzy_match_catalog(
    phrase: str,
    catalog: list[dict],
    preferred_unit: Optional[str] = None,
) -> tuple[Optional[dict], float, list[dict]]:
    """Return (best_item, confidence, near_ties)."""
    scored: list[tuple[float, dict]] = []
    for item in catalog:
        name = item.get('name') or ''
        score = _similarity(phrase, name)
        # Light boost when requested unit matches catalog unit
        cat_unit = _normalize_unit(item.get('unit'))
        if preferred_unit and cat_unit and preferred_unit == cat_unit:
            score = min(1.0, score + 0.05)
        scored.append((score, item))

    scored.sort(key=lambda x: x[0], reverse=True)
    if not scored or scored[0][0] < LOW_CONFIDENCE:
        return None, 0.0, []

    best_score, best = scored[0]
    ties = [
        {'id': it['id'], 'name': it.get('name'), 'score': round(sc, 3)}
        for sc, it in scored[1:4]
        if abs(sc - best_score) <= AMBIGUITY_GAP and sc >= LOW_CONFIDENCE
    ]
    if ties and best_score < 0.95:
        return None, best_score, [
            {'id': best['id'], 'name': best.get('name'), 'score': round(best_score, 3)},
            *ties,
        ]
    return best, best_score, []


async def _fetch_catalog(supplier_id: str) -> list[dict]:
    base = (settings.autom8_supabase_url or '').rstrip('/')
    key = settings.autom8_supabase_service_key or ''
    if not base or not key:
        return []
    headers = {
        'apikey': key,
        'Authorization': f'Bearer {key}',
    }
    async with httpx.AsyncClient(timeout=12) as client:
        resp = await client.get(
            f'{base}/rest/v1/supply_catalog_items',
            headers=headers,
            params={
                'supplier_id': f'eq.{supplier_id}',
                'is_active': 'eq.true',
                'is_available': 'eq.true',
                'select': 'id,name,category,unit,unit_type,default_price,gst_rate,min_order_qty',
                'order': 'name.asc',
            },
        )
    if resp.status_code != 200:
        logger.error(
            '[nlp-parser] catalog fetch HTTP %s: %s',
            resp.status_code, resp.text[:200],
        )
        return []
    return resp.json() or []


async def is_nlp_order_enabled(supplier_id: str) -> bool:
    """
    Per-supplier flag (default off). Also honors env allow-list for pilot
    before/without migration: SUPPLY_NLP_ENABLED_SUPPLIERS=uuid,uuid
    """
    import os
    allow = (os.getenv('SUPPLY_NLP_ENABLED_SUPPLIERS') or '').strip()
    if allow:
        allowed = {x.strip() for x in allow.split(',') if x.strip()}
        if supplier_id in allowed:
            return True

    base = (settings.autom8_supabase_url or '').rstrip('/')
    key = settings.autom8_supabase_service_key or ''
    if not base or not key:
        return False
    headers = {
        'apikey': key,
        'Authorization': f'Bearer {key}',
    }
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            resp = await client.get(
                f'{base}/rest/v1/suppliers',
                headers=headers,
                params={
                    'id': f'eq.{supplier_id}',
                    'select': 'nlp_order_parsing_enabled',
                    'limit': '1',
                },
            )
        if resp.status_code != 200:
            return False
        rows = resp.json() or []
        if not rows:
            return False
        return bool(rows[0].get('nlp_order_parsing_enabled'))
    except Exception as exc:
        logger.debug('[nlp-parser] feature flag read failed: %s', exc)
        return False


async def _llm_parse_segment(segment: str, catalog_names: list[str]) -> Optional[dict]:
    """
    Gemini 2.0 Flash fallback for one segment. Same client pattern as
    conversation_intelligence.classify_intent (google-genai) — no import
    from customer LOB modules.
    """
    if not settings.google_api_key:
        return None
    try:
        from google import genai

        client = genai.Client(api_key=settings.google_api_key)
        name_hint = ', '.join(catalog_names[:80])
        prompt = (
            "Extract a single wholesale order line from this WhatsApp fragment "
            "(English/Hindi/Hinglish). Return ONLY JSON, no markdown.\n"
            f'Fragment: "{segment}"\n'
            f"Known catalog names (hint only): {name_hint}\n"
            "JSON shape:\n"
            '{"item_phrase":"string","quantity":0.0,"unit":"string or null",'
            '"confidence":0.0}\n'
            "If not an order line, return "
            '{"item_phrase":null,"quantity":null,"unit":null,"confidence":0}'
        )
        response = await asyncio.to_thread(
            client.models.generate_content,
            model='gemini-2.0-flash',
            contents=prompt,
        )
        result_text = (response.text or '').strip()
        if '```' in result_text:
            parts = result_text.split('```')
            result_text = parts[1] if len(parts) > 1 else parts[0]
            if result_text.startswith('json'):
                result_text = result_text[4:]
            result_text = result_text.strip()
        data = json.loads(result_text)
        phrase = data.get('item_phrase')
        qty = data.get('quantity')
        if not phrase or qty is None:
            return None
        qty_f = float(qty)
        if qty_f <= 0:
            return None
        return {
            'quantity': qty_f,
            'unit': _normalize_unit(data.get('unit')),
            'item_phrase': str(phrase).strip(),
            'raw': segment,
            'llm_confidence': float(data.get('confidence') or 0.6),
        }
    except Exception as exc:
        logger.debug('[nlp-parser] LLM segment fallback failed: %s', exc)
        return None


async def parse_supply_order_text(
    raw_text: str,
    supplier_id: str,
    client_id: str,  # reserved for future client-specific aliases
) -> ParseResult:
    """
    Parse free-text into catalog-matched line items.
    client_id is accepted for API symmetry / future alias tables.
    """
    _ = client_id
    result = ParseResult()
    text = (raw_text or '').strip()
    if not text:
        return result

    catalog = await _fetch_catalog(supplier_id)
    if not catalog:
        result.unmatched.append(text)
        return result

    catalog_names = [c.get('name') or '' for c in catalog]
    segments = _split_segments(text)

    for segment in segments:
        extracted = _extract_qty_unit_item(segment)
        source = 'fast'

        if not extracted or not extracted.get('item_phrase'):
            llm = await _llm_parse_segment(segment, catalog_names)
            if not llm:
                result.unmatched.append(segment)
                continue
            extracted = llm
            source = 'llm'

        best, score, ties = _fuzzy_match_catalog(
            extracted['item_phrase'],
            catalog,
            preferred_unit=extracted.get('unit'),
        )

        # Low-confidence fast path → try LLM re-phrase then rematch
        if (not best or score < HIGH_CONFIDENCE) and source == 'fast':
            llm = await _llm_parse_segment(segment, catalog_names)
            if llm:
                best2, score2, ties2 = _fuzzy_match_catalog(
                    llm['item_phrase'],
                    catalog,
                    preferred_unit=llm.get('unit') or extracted.get('unit'),
                )
                if best2 and score2 > score:
                    best, score, ties = best2, score2, ties2
                    extracted = {**extracted, **llm}
                    source = 'llm'

        if ties:
            result.ambiguous.append({
                'segment': segment,
                'candidates': ties,
                'quantity': extracted['quantity'],
                'unit': extracted.get('unit'),
            })
            continue

        if not best or score < LOW_CONFIDENCE:
            result.unmatched.append(segment)
            continue

        # Prefer catalog unit; keep extracted unit only as hint
        unit = best.get('unit') or extracted.get('unit')
        conf = score
        if source == 'llm':
            conf = min(conf, max(score, float(extracted.get('llm_confidence') or score)))

        result.matched.append(ParsedLine(
            catalog_item_id=best['id'],
            matched_name=best.get('name'),
            quantity=float(extracted['quantity']),
            unit=unit,
            confidence=round(float(conf), 3),
            raw_segment=segment,
            source=source,
        ))

    return result
