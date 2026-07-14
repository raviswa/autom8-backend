"""
Delivery distance — geocoding, road distance (Google Maps), radius checks.

Requires GOOGLE_MAPS_API_KEY on Railway (Geocoding + Distance Matrix APIs enabled).
Falls back to straight-line haversine when the API key is missing or calls fail.
"""

from __future__ import annotations

import logging
import math
import os
import re
import time as _time
from typing import Any

from config.settings import settings
from tools.booking_mechanisms import get_http
from tools.order_pricing import (
    DEFAULT_DELIVERY_CHARGE,
    DEFAULT_DELIVERY_TIERS,
    delivery_charge_from_tiers,
    haversine_km,
)

logger = logging.getLogger(__name__)

GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json"
DISTANCE_MATRIX_URL = "https://maps.googleapis.com/maps/api/distancematrix/json"


def maps_api_key() -> str:
    return (
        os.getenv("GOOGLE_MAPS_API_KEY", "").strip()
        or getattr(settings, "google_maps_api_key", "")
        or settings.google_api_key
        or ""
    )


def _parse_coords_from_text(text: str) -> tuple[float, float] | None:
    """Extract lat,lng from maps URLs or raw coordinate pairs."""
    if not text:
        return None
    m = re.search(r"maps\.google\.com/\?q=([-\d.]+),([-\d.]+)", text)
    if m:
        return float(m.group(1)), float(m.group(2))
    m = re.search(r"([-]?\d{1,3}\.\d{3,})\s*,\s*([-]?\d{1,3}\.\d{3,})", text)
    if m:
        return float(m.group(1)), float(m.group(2))
    return None


def _restaurant_coords(state: dict[str, Any]) -> tuple[float, float] | None:
    try:
        lat = state.get("pickup_latitude")
        lng = state.get("pickup_longitude")
        if lat is not None and lng is not None:
            return float(lat), float(lng)
    except (TypeError, ValueError):
        pass
    return None


def _customer_coords(state: dict[str, Any]) -> tuple[float, float] | None:
    try:
        lat = state.get("delivery_lat")
        lng = state.get("delivery_lng")
        if lat is not None and lng is not None:
            return float(lat), float(lng)
    except (TypeError, ValueError):
        pass
    return None


_REVERSE_PREF_TYPES = frozenset({"street_address", "premise", "subpremise", "route"})


def _dedupe_geocode_candidates(results: list[Any], limit: int = 4) -> list[dict[str, Any]]:
    seen: set[str] = set()
    out: list[dict[str, Any]] = []

    for r in results:
        if not isinstance(r, dict):
            continue
        formatted = (r.get("formatted_address") or "").strip()
        loc = (r.get("geometry") or {}).get("location") or {}
        try:
            lat = float(loc["lat"])
            lng = float(loc["lng"])
        except (KeyError, TypeError, ValueError):
            continue
        if not formatted or formatted in seen:
            continue
        seen.add(formatted)
        out.append(
            {
                "formatted_address": formatted,
                "place_id": r.get("place_id") or None,
                "lat": lat,
                "lng": lng,
            }
        )
        if len(out) >= limit:
            break
    return out


async def reverse_geocode_candidates(
    lat: float,
    lng: float,
    *,
    limit: int = 4,
) -> list[dict[str, Any]]:
    """
    Reverse-geocode a pin into up to `limit` nearby formatted addresses.
    Prefers street/premise/route results; returns [] when the API key is
    missing or the call fails.
    """
    api_key = maps_api_key()
    if not api_key:
        logger.warning("[reverse-geocode] GOOGLE_MAPS_API_KEY missing; disabled")
        return []

    try:
        resp = await get_http().get(
            GEOCODE_URL,
            params={
                "latlng": f"{lat},{lng}",
                "key": api_key,
            },
            timeout=__import__("aiohttp").ClientTimeout(total=8),
        )
        if resp.status != 200:
            logger.warning(f"[reverse-geocode] HTTP {resp.status}")
            return []
        data = await resp.json()
        if data.get("status") != "OK" or not data.get("results"):
            logger.info(f"[reverse-geocode] no result status={data.get('status')}")
            return []

        results = data["results"]
        preferred = [
            r for r in results
            if isinstance(r, dict)
            and isinstance(r.get("types"), list)
            and any(t in _REVERSE_PREF_TYPES for t in r["types"])
        ]
        ranked = [*preferred, *results] if preferred else results
        return _dedupe_geocode_candidates(ranked, limit=limit)
    except Exception as e:
        logger.warning(f"[reverse-geocode] failed: {e}")
        return []


async def geocode_address(address: str, *, city: str = "", state_name: str = "") -> tuple[float, float] | None:
    """
    Resolve a typed delivery address to coordinates via Google Geocoding API.
    """
    api_key = maps_api_key()
    if not api_key or not (address or "").strip():
        return None

    query = address.strip()
    if city and city.lower() not in query.lower():
        query = f"{query}, {city}"
    if state_name and state_name.lower() not in query.lower():
        query = f"{query}, {state_name}"

    try:
        resp = await get_http().get(
            GEOCODE_URL,
            params={
                "address": query,
                "key": api_key,
                "region": "in",
                "components": "country:IN",
            },
            timeout=__import__("aiohttp").ClientTimeout(total=8),
        )
        if resp.status != 200:
            logger.warning(f"[geocode] HTTP {resp.status}")
            return None
        data = await resp.json()
        if data.get("status") != "OK" or not data.get("results"):
            logger.info(f"[geocode] no result for address status={data.get('status')}")
            return None
        loc = data["results"][0]["geometry"]["location"]
        return float(loc["lat"]), float(loc["lng"])
    except Exception as e:
        logger.warning(f"[geocode] failed: {e}")
        return None


async def road_route_metrics(
    origin: tuple[float, float],
    destination: tuple[float, float],
) -> dict[str, Any] | None:
    """
    Road distance + drive time via Google Distance Matrix API.
    Uses duration_in_traffic when departure_time is set (city vs suburb aware).
    """
    api_key = maps_api_key()
    if not api_key:
        return None

    o_lat, o_lng = origin
    d_lat, d_lng = destination
    try:
        resp = await get_http().get(
            DISTANCE_MATRIX_URL,
            params={
                "origins": f"{o_lat},{o_lng}",
                "destinations": f"{d_lat},{d_lng}",
                "mode": "driving",
                "departure_time": int(_time.time()),
                "traffic_model": "best_guess",
                "key": api_key,
            },
            timeout=__import__("aiohttp").ClientTimeout(total=8),
        )
        if resp.status != 200:
            return None
        data = await resp.json()
        if data.get("status") != "OK":
            logger.info(f"[distance-matrix] status={data.get('status')}")
            return None
        rows = data.get("rows") or []
        if not rows or not rows[0].get("elements"):
            return None
        el = rows[0]["elements"][0]
        if el.get("status") != "OK":
            return None

        metres = el["distance"]["value"]
        duration_sec = el.get("duration", {}).get("value")
        traffic_sec = el.get("duration_in_traffic", {}).get("value")

        duration_min = math.ceil(duration_sec / 60) if duration_sec else None
        traffic_min = math.ceil(traffic_sec / 60) if traffic_sec else None
        travel_minutes = traffic_min or duration_min

        if not travel_minutes:
            return None

        return {
            "distance_km": round(metres / 1000.0, 2),
            "duration_minutes": duration_min,
            "duration_in_traffic_minutes": traffic_min,
            "travel_minutes": travel_minutes,
            "traffic_aware": traffic_min is not None,
        }
    except Exception as e:
        logger.warning(f"[distance-matrix] failed: {e}")
        return None


async def road_distance_km(
    origin: tuple[float, float],
    destination: tuple[float, float],
) -> float | None:
    """Driving distance in km via Google Distance Matrix API."""
    metrics = await road_route_metrics(origin, destination)
    return metrics["distance_km"] if metrics else None


async def ensure_customer_coordinates(
    session_state: dict[str, Any],
    *,
    address_text: str | None = None,
) -> bool:
    """
    Populate delivery_lat/lng from WhatsApp pin, maps URL, or geocoded text.
    Returns True if coordinates are available after this call.
    """
    if _customer_coords(session_state):
        return True

    raw = (address_text or session_state.get("delivery_address") or "").strip()
    parsed = _parse_coords_from_text(raw)
    if parsed:
        session_state["delivery_lat"], session_state["delivery_lng"] = parsed
        return True

    if raw.startswith("LOCATION:"):
        return False

    city = (session_state.get("restaurant_city") or "").strip()
    state_name = (session_state.get("restaurant_state") or "").strip()
    geocoded = await geocode_address(raw, city=city, state_name=state_name)
    if geocoded:
        session_state["delivery_lat"], session_state["delivery_lng"] = geocoded
        session_state["delivery_geocoded"] = True
        return True

    return False


async def compute_delivery_distance(session_state: dict[str, Any]) -> dict[str, Any]:
    """
    Compute distance kitchen → customer. Prefers road distance when API key is set.
    Writes delivery_distance_km and delivery_distance_method on session_state.
    """
    origin = _restaurant_coords(session_state)
    dest = _customer_coords(session_state)

    result: dict[str, Any] = {
        "distance_km": None,
        "distance_method": None,
        "within_radius": True,
        "max_radius_km": float(session_state.get("max_delivery_radius_km") or 0),
    }

    if not origin or not dest:
        session_state.pop("delivery_distance_km", None)
        session_state.pop("delivery_distance_method", None)
        session_state.pop("delivery_travel_minutes", None)
        session_state.pop("delivery_travel_traffic_aware", None)
        return result

    route = await road_route_metrics(origin, dest)
    if route is not None:
        distance = route["distance_km"]
        method = "road"
        session_state["delivery_travel_minutes"] = route["travel_minutes"]
        session_state["delivery_travel_traffic_aware"] = route["traffic_aware"]
        result["travel_minutes"] = route["travel_minutes"]
        result["travel_traffic_aware"] = route["traffic_aware"]
    else:
        distance = haversine_km(origin[0], origin[1], dest[0], dest[1])
        method = "straight"
        session_state.pop("delivery_travel_minutes", None)
        session_state.pop("delivery_travel_traffic_aware", None)

    session_state["delivery_distance_km"] = distance
    session_state["delivery_distance_method"] = method
    result["distance_km"] = distance
    result["distance_method"] = method

    max_r = result["max_radius_km"]
    if max_r > 0 and distance is not None:
        result["within_radius"] = distance <= max_r

    return result


def check_delivery_radius(session_state: dict[str, Any]) -> tuple[bool, str | None]:
    """
    Returns (allowed, rejection_message).
    Only rejects when distance is known and exceeds configured cap.
    """
    max_r = float(session_state.get("max_delivery_radius_km") or 0)
    if max_r <= 0:
        return True, None

    distance = session_state.get("delivery_distance_km")
    if distance is None:
        return True, None

    if float(distance) <= max_r:
        return True, None

    dist_label = format_distance_label(float(distance), session_state.get("delivery_distance_method"))
    return (
        False,
        f"Sorry — we deliver only within *{max_r:g} km* of our kitchen. "
        f"Your location is about *{dist_label}* away.\n\n"
        "Please share a closer address, or tap *Share location* on WhatsApp for an accurate pin.",
    )


def resolve_delivery_charge_from_session(session_state: dict[str, Any] | None) -> float:
    """Delivery fee using pre-computed session distance when available."""
    state = session_state or {}
    default = float(state.get("delivery_charge_default") or DEFAULT_DELIVERY_CHARGE)
    tiers = state.get("delivery_charge_tiers") or DEFAULT_DELIVERY_TIERS
    distance = state.get("delivery_distance_km")
    try:
        distance = float(distance) if distance is not None else None
    except (TypeError, ValueError):
        distance = None
    return delivery_charge_from_tiers(distance, tiers, default_charge=default)


async def finalize_delivery_address(
    session_state: dict[str, Any],
    *,
    address_text: str | None = None,
) -> dict[str, Any]:
    """
    Geocode (if needed), compute distance, check radius.
    Returns {ok, distance_km, distance_method, charge, message}.
    """
    await ensure_customer_coordinates(session_state, address_text=address_text)
    dist_info = await compute_delivery_distance(session_state)

    allowed, reject_msg = check_delivery_radius(session_state)
    if not allowed:
        return {
            "ok": False,
            "message": reject_msg,
            "distance_km": dist_info.get("distance_km"),
            "distance_method": dist_info.get("distance_method"),
        }

    charge = resolve_delivery_charge_from_session(session_state)
    session_state["delivery_charge_preview"] = charge

    preview = build_distance_charge_preview(session_state, charge)
    return {
        "ok": True,
        "message": preview,
        "distance_km": dist_info.get("distance_km"),
        "distance_method": dist_info.get("distance_method"),
        "charge": charge,
    }


def format_distance_label(distance_km: float | None, method: str | None = None) -> str:
    if distance_km is None:
        return ""
    label = f"{distance_km:g} km"
    if method == "road":
        return f"{label} by road"
    if method == "straight":
        return f"{label} approx."
    return label


def build_distance_charge_preview(session_state: dict[str, Any], charge: float | None = None) -> str | None:
    """Short note after address capture — distance + indicative delivery fee."""
    distance = session_state.get("delivery_distance_km")
    if distance is None:
        return None

    fee = charge if charge is not None else resolve_delivery_charge_from_session(session_state)
    dist_label = format_distance_label(
        float(distance),
        session_state.get("delivery_distance_method"),
    )
    travel_note = ""
    travel = session_state.get("delivery_travel_minutes")
    if travel and session_state.get("delivery_distance_method") == "road":
        traffic = " (current traffic)" if session_state.get("delivery_travel_traffic_aware") else ""
        travel_note = f" Drive time{traffic}: *~{int(travel)} mins*."
    return (
        f"📍 You're about *{dist_label}* from our kitchen.{travel_note} "
        f"Delivery charge: *₹{fee:.0f}*."
    )


def format_delivery_line(totals: dict[str, float], session_state: dict[str, Any] | None) -> str:
    """Delivery charge line with optional distance suffix for WhatsApp breakdowns."""
    charge = totals.get("delivery_charge", 0)
    if charge <= 0:
        return ""

    state = session_state or {}
    distance = state.get("delivery_distance_km")
    line = f"Delivery: ₹{charge:.0f}"
    if distance is not None:
        dist_label = format_distance_label(
            float(distance),
            state.get("delivery_distance_method"),
        )
        line += f" (~{dist_label} from our kitchen)"
    return line
