"""
Munafe — Receipt / Bill Generator
===================================
Generates a branded receipt PNG for each completed order.

Usage — CLI:
    python generate_receipt.py --demo          # renders a demo receipt
    python generate_receipt.py --json bill.json

Usage — import in FastAPI / booking_agent:
    from generate_receipt import generate_receipt, ReceiptData, LineItem

Dependencies:
    pip install qrcode[pil] pillow
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional
from urllib.parse import quote
from zoneinfo import ZoneInfo

try:
    import qrcode
    from PIL import Image, ImageDraw, ImageFont
except ImportError as _e:
    raise ImportError(
        f"generate_receipt requires qrcode[pil] and Pillow: {_e}. "
        "Run: pip install qrcode[pil] pillow"
    ) from _e


# ─── Design tokens ────────────────────────────────────────────────────────────

RECEIPT_WIDTH   = 420          # px — narrow receipt-paper width
PADDING         = 28           # horizontal padding
LINE_SPACING    = 26           # vertical line height for body text
SECTION_GAP     = 14           # gap between sections
HEADER_H        = 8            # top accent bar height
FOOTER_H        = 8            # bottom accent bar height

COLOR_GREEN     = "#25D366"    # WhatsApp / Munafe brand green
COLOR_DARK      = "#111111"
COLOR_MID       = "#444444"
COLOR_LIGHT     = "#888888"
COLOR_DIVIDER   = "#CCCCCC"
COLOR_BG        = "#FFFFFF"
COLOR_SUBTLBG   = "#F7F7F7"    # used for totals block

OUTPUT_DIR = Path(os.getenv("RECEIPT_OUTPUT_DIR", "/tmp/receipt_output"))

# System font search order
_BOLD_FONTS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "C:/Windows/Fonts/arialbd.ttf",
]
_REGULAR_FONTS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "C:/Windows/Fonts/arial.ttf",
]
_MONO_FONTS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "/usr/share/fonts/truetype/ubuntu/UbuntuMono-R.ttf",
    "/System/Library/Fonts/Courier.ttc",
    "C:/Windows/Fonts/cour.ttf",
]


def _font(paths: list[str], size: int):
    for p in paths:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()


# ─── Data model ───────────────────────────────────────────────────────────────

@dataclass
class LineItem:
    """One line on the bill."""
    name: str
    qty: int = 1
    unit_price: float = 0.0

    @property
    def total(self) -> float:
        return round(self.qty * self.unit_price, 2)

    @classmethod
    def from_cart(cls, cart: dict) -> list["LineItem"]:
        items = []
        for v in cart.values():
            items.append(cls(
                name=v.get("title") or v.get("name") or "Item",
                qty=int(v.get("qty", 1)),
                unit_price=float(v.get("unit_price", 0)),
            ))
        return items

    @classmethod
    def from_order_text(cls, order_text: str) -> list["LineItem"]:
        return [cls(name=order_text, qty=1, unit_price=0.0)]


@dataclass
class ReceiptData:
    """All data needed to render one receipt."""

    # ── Restaurant ─────────────────────────────────────────────────────────
    restaurant_name: str = "Munafe Restaurant"
    restaurant_address: str = ""
    restaurant_phone: str = ""
    restaurant_gstin: str = ""
    restaurant_wa_number: str = ""
    restaurant_website: str = ""    # e.g. "https://munafe.in"

    # ── Order meta ─────────────────────────────────────────────────────────
    token_number: str = ""
    table_number: str = ""
    service_type: str = "dine_in"
    order_datetime: str = ""
    receipt_number: str = ""

    # ── Customer ───────────────────────────────────────────────────────────
    customer_name: str = ""
    customer_phone: str = ""
    delivery_address: str = ""

    # ── Items ──────────────────────────────────────────────────────────────
    items: list[LineItem] = field(default_factory=list)

    # ── Financials ─────────────────────────────────────────────────────────
    gst_rate: float = 5.0
    gst_inclusive: bool = False
    delivery_charge: float = 0.0
    discount: float = 0.0
    discount_label: str = "Discount"
    payment_mode: str = "Cash"

    # ── Extras ─────────────────────────────────────────────────────────────
    special_notes: str = ""
    footer_message: str = "Thank you for dining with us! 😊"
    receipt_url: str = ""              # if set, QR links here; else falls back to WA reorder

    def __post_init__(self):
        if not self.order_datetime:
            self.order_datetime = datetime.now(
                ZoneInfo("Asia/Kolkata")
            ).strftime("%d %b %Y, %I:%M %p")

    @property
    def items_subtotal(self) -> float:
        return round(sum(i.total for i in self.items), 2)

    @property
    def taxable_amount(self) -> float:
        if self.gst_inclusive and self.gst_rate > 0:
            return round(self.items_subtotal / (1 + self.gst_rate / 100), 2)
        return self.items_subtotal

    @property
    def gst_amount(self) -> float:
        return round(self.items_subtotal - self.taxable_amount
                     if self.gst_inclusive
                     else self.taxable_amount * self.gst_rate / 100, 2)

    @property
    def cgst(self) -> float:
        return round(self.gst_amount / 2, 2)

    @property
    def sgst(self) -> float:
        return round(self.gst_amount / 2, 2)

    @property
    def grand_total(self) -> float:
        base = (self.items_subtotal if self.gst_inclusive
                else self.taxable_amount + self.gst_amount)
        return round(base + self.delivery_charge - self.discount, 2)

    @classmethod
    def from_booking_session(cls, session_state: dict, cart: dict, restaurant: dict) -> "ReceiptData":
        service_type = session_state.get("service_type", "dine_in")
        return cls(
            restaurant_name=restaurant.get("name", ""),
            restaurant_wa_number=restaurant.get("whatsapp_number", ""),
            token_number=str(session_state.get("display_token") or
                             session_state.get("token_number") or ""),
            table_number=str(session_state.get("table_number") or ""),
            service_type=service_type,
            receipt_number=str(session_state.get("booking_id") or "")[:8].upper(),
            customer_name=session_state.get("customer_name", ""),
            customer_phone=session_state.get("customer_phone", ""),
            delivery_address=session_state.get("delivery_address", ""),
            items=LineItem.from_cart(cart) if cart else [],
            delivery_charge=40.0 if service_type == "delivery" else 0.0,
            payment_mode="Online" if session_state.get("payment_link") else "Cash",
            special_notes=session_state.get("special_notes") or "",
        )

    @classmethod
    def from_json(cls, path: str) -> "ReceiptData":
        with open(path) as f:
            data = json.load(f)
        items = [LineItem(**i) for i in data.pop("items", [])]
        return cls(items=items, **data)


# ─── Renderer ─────────────────────────────────────────────────────────────────

class ReceiptRenderer:
    """Draws a receipt PNG onto a PIL Image."""

    def __init__(self, data: ReceiptData):
        self.data = data
        self.draw: ImageDraw.ImageDraw = None
        self.img: Image.Image = None
        self.y = 0

        self.f_title   = _font(_BOLD_FONTS,    22)
        self.f_heading = _font(_BOLD_FONTS,    15)
        self.f_bold    = _font(_BOLD_FONTS,    13)
        self.f_body    = _font(_REGULAR_FONTS, 13)
        self.f_small   = _font(_REGULAR_FONTS, 11)
        self.f_mono    = _font(_MONO_FONTS,    12)

    def _tw(self, text: str, font) -> int:
        bbox = self.draw.textbbox((0, 0), text, font=font)
        return bbox[2] - bbox[0]

    def _center(self, text: str, font, color=COLOR_DARK, y_offset: int = 0):
        tw = self._tw(text, font)
        x = (RECEIPT_WIDTH - tw) / 2
        self.draw.text((x, self.y + y_offset), text, fill=color, font=font)
        self.y += LINE_SPACING

    def _left(self, text: str, font, color=COLOR_DARK, indent: int = 0):
        self.draw.text((PADDING + indent, self.y), text, fill=color, font=font)
        self.y += LINE_SPACING

    def _two_col(self, left: str, right: str, font_l=None, font_r=None,
                 color_l=COLOR_DARK, color_r=COLOR_DARK, bold_right=False):
        fl = font_l or self.f_body
        fr = font_r or (self.f_bold if bold_right else self.f_body)
        self.draw.text((PADDING, self.y), left, fill=color_l, font=fl)
        tw = self._tw(right, fr)
        self.draw.text((RECEIPT_WIDTH - PADDING - tw, self.y), right, fill=color_r, font=fr)
        self.y += LINE_SPACING

    def _divider(self, style: str = "solid", gap: int = 8):
        self.y += gap
        if style == "dashed":
            x, ex = PADDING, RECEIPT_WIDTH - PADDING
            dash_w, gap_w = 6, 4
            xp = x
            while xp < ex:
                self.draw.line([(xp, self.y), (min(xp + dash_w, ex), self.y)],
                               fill=COLOR_DIVIDER, width=1)
                xp += dash_w + gap_w
        else:
            self.draw.line([(PADDING, self.y), (RECEIPT_WIDTH - PADDING, self.y)],
                           fill=COLOR_DIVIDER, width=1)
        self.y += gap + 2

    def _gap(self, px: int = 10):
        self.y += px

    def _section_header(self):
        d = self.data
        self._gap(4)
        self._center(d.restaurant_name, self.f_title, COLOR_DARK)
        if d.restaurant_address:
            for line in d.restaurant_address.split("\n"):
                self._center(line.strip(), self.f_small, COLOR_LIGHT)
        if d.restaurant_phone:
            self._center(f"Ph: {d.restaurant_phone}", self.f_small, COLOR_LIGHT)
        if d.restaurant_gstin:
            self._center(f"GSTIN: {d.restaurant_gstin}", self.f_small, COLOR_LIGHT)
        if d.restaurant_website:
            self._center(d.restaurant_website, self.f_small, COLOR_GREEN)
        self._gap(4)

    def _section_order_meta(self):
        d = self.data
        self._divider("solid")
        svc_label = {
            "dine_in":       "Dine-in",
            "takeaway":      "Takeaway",
            "delivery":      "Delivery",
            "reserve_table": "Reservation",
        }.get(d.service_type, d.service_type.replace("_", " ").title())
        if d.token_number:
            self._two_col("Token", str(d.token_number), bold_right=True,
                          color_r=COLOR_GREEN, font_r=self.f_bold)
        if d.table_number:
            self._two_col("Table", str(d.table_number))
        self._two_col("Service", svc_label)
        self._two_col("Date & Time", d.order_datetime)
        if d.receipt_number:
            self._two_col("Receipt #", d.receipt_number,
                          color_r=COLOR_LIGHT, font_r=self.f_small)

    def _section_customer(self):
        d = self.data
        if not (d.customer_name or d.customer_phone or d.delivery_address):
            return
        self._divider("dashed")
        if d.customer_name:
            self._two_col("Customer", d.customer_name, font_r=self.f_bold)
        if d.customer_phone:
            self._two_col("WhatsApp", f"+{d.customer_phone.lstrip('+')}")
        if d.service_type == "delivery" and d.delivery_address:
            self._left("Delivery to:", self.f_small, COLOR_LIGHT)
            addr = d.delivery_address
            if len(addr) > 45:
                addr = addr[:43] + "…"
            self._left(addr, self.f_small, COLOR_MID, indent=8)

    def _section_items(self):
        d = self.data
        if not d.items:
            return
        self._divider("dashed")
        self._two_col("ITEM", "AMOUNT", font_l=self.f_bold, font_r=self.f_bold,
                      color_l=COLOR_MID, color_r=COLOR_MID)
        self._gap(2)
        for item in d.items:
            name = item.name
            if len(name) > 28:
                name = name[:26] + "…"
            qty_label = f"{name}"
            if item.qty > 1:
                qty_label += f"  x{item.qty}"
            amt = f"Rs.{item.total:.2f}" if item.unit_price > 0 else ""
            self._two_col(qty_label, amt, font_r=self.f_mono)
        if d.special_notes:
            self._gap(4)
            self._left("Notes:", self.f_small, COLOR_LIGHT)
            note = d.special_notes
            if len(note) > 45:
                note = note[:43] + "…"
            self._left(note, self.f_small, COLOR_MID, indent=8)

    def _section_totals(self):
        d = self.data
        self._divider("solid")
        if d.items and any(i.unit_price > 0 for i in d.items):
            self._two_col("Subtotal", f"Rs.{d.taxable_amount:.2f}",
                          color_l=COLOR_MID, color_r=COLOR_MID)
        if d.gst_rate > 0 and d.gst_amount > 0:
            half = d.gst_rate / 2
            self._two_col(f"CGST ({half:.1f}%)", f"Rs.{d.cgst:.2f}",
                          color_l=COLOR_MID, color_r=COLOR_MID)
            self._two_col(f"SGST ({half:.1f}%)", f"Rs.{d.sgst:.2f}",
                          color_l=COLOR_MID, color_r=COLOR_MID)
        if d.delivery_charge > 0:
            self._two_col("Delivery charge", f"Rs.{d.delivery_charge:.2f}",
                          color_l=COLOR_MID, color_r=COLOR_MID)
        if d.discount > 0:
            self._two_col(d.discount_label, f"- Rs.{d.discount:.2f}",
                          color_l=COLOR_MID, color_r=COLOR_MID)
        self._divider("solid", gap=4)
        self._two_col("TOTAL", f"Rs.{d.grand_total:.2f}",
                      font_l=self.f_heading, font_r=self.f_heading,
                      color_r=COLOR_GREEN, bold_right=True)
        self._two_col("Payment mode", d.payment_mode,
                      color_l=COLOR_LIGHT, color_r=COLOR_MID,
                      font_l=self.f_small, font_r=self.f_small)

    def _section_reorder_qr(self):
        d = self.data
        if d.receipt_url:
            qr_url   = d.receipt_url
            qr_label = "Scan for your digital receipt"
        elif d.restaurant_wa_number:
            wa_num   = d.restaurant_wa_number.lstrip("+")
            qr_url   = f"https://wa.me/{wa_num}?text=Hi"
            qr_label = "Scan to order again"
        else:
            return
        self._divider("dashed")
        self._gap(4)
        self._center(qr_label, self.f_small, COLOR_LIGHT)
        self._gap(4)
        qr = qrcode.QRCode(version=1, box_size=4, border=2,
                           error_correction=qrcode.constants.ERROR_CORRECT_M)
        qr.add_data(qr_url)
        qr.make(fit=True)
        qr_img = qr.make_image(fill_color="black", back_color="white").convert("RGB")
        qx = (RECEIPT_WIDTH - qr_img.width) // 2
        self.img.paste(qr_img, (qx, self.y))
        self.y += qr_img.height + 8

    def _section_footer(self):
        self._gap(6)
        self._center(self.data.footer_message, self.f_small, COLOR_MID)
        self._gap(4)
        self._center("Powered by Munafe", self.f_small, COLOR_LIGHT)
        self._gap(4)

    def render(self) -> Image.Image:
        self._estimate_height()
        total_height = self.y + FOOTER_H + 20
        self.img = Image.new("RGB", (RECEIPT_WIDTH, total_height), COLOR_BG)
        self.draw = ImageDraw.Draw(self.img)
        self.y = 0
        self.draw.rectangle([(0, 0), (RECEIPT_WIDTH, HEADER_H)], fill=COLOR_GREEN)
        self.y = HEADER_H + 8
        self._section_header()
        self._section_order_meta()
        self._section_customer()
        self._section_items()
        self._section_totals()
        self._section_reorder_qr()
        self._section_footer()
        self.draw.rectangle([(0, total_height - FOOTER_H),
                              (RECEIPT_WIDTH, total_height)], fill=COLOR_GREEN)
        return self.img

    def _estimate_height(self):
        self.img = Image.new("RGB", (RECEIPT_WIDTH, 1), COLOR_BG)
        self.draw = ImageDraw.Draw(self.img)
        self.y = HEADER_H + 8
        self._section_header()
        self._section_order_meta()
        self._section_customer()
        self._section_items()
        self._section_totals()
        if self.data.restaurant_wa_number or self.data.receipt_url:
            self.y += 100
        self._section_footer()


# ─── Public API ───────────────────────────────────────────────────────────────

def generate_receipt(data: ReceiptData, output_path: Path | None = None) -> Path:
    OUTPUT_DIR.mkdir(exist_ok=True)
    if output_path is None:
        token = data.token_number.replace("#", "").replace("/", "-") or "receipt"
        name  = data.restaurant_name.replace(" ", "_")
        output_path = OUTPUT_DIR / f"{name}_receipt_{token}.png"
    img = ReceiptRenderer(data).render()
    img.save(output_path, "PNG", dpi=(300, 300))
    return output_path


# ─── Demo / CLI ───────────────────────────────────────────────────────────────

DEMO_DATA = ReceiptData(
    restaurant_name="Murugan Idli Shop",
    restaurant_address="15, Gandhi Road, T. Nagar\nChennai - 600017",
    restaurant_phone="919444109431",
    restaurant_gstin="33AAAAA0000A1Z5",
    restaurant_wa_number="919500996033",
    token_number="#007",
    table_number="4",
    service_type="dine_in",
    order_datetime="06 Jun 2026, 08:30 PM",
    receipt_number="INV-2026-007",
    customer_name="Ravi Sharma",
    customer_phone="919444109431",
    items=[
        LineItem("Chicken Biryani",  qty=2, unit_price=180.0),
        LineItem("Onion Parotta",    qty=4, unit_price=30.0),
        LineItem("Chicken Salna",    qty=2, unit_price=60.0),
        LineItem("Masala Chai",      qty=2, unit_price=30.0),
    ],
    gst_rate=5.0,
    gst_inclusive=False,
    payment_mode="UPI",
    special_notes="Extra spicy, no onion for biryani",
    footer_message="Thank you for dining with us! 😊",
)


def main():
    parser = argparse.ArgumentParser(description="Munafe receipt generator")
    parser.add_argument("--demo", action="store_true", help="Render a demo receipt")
    parser.add_argument("--json", metavar="FILE", help="Generate receipt from a JSON file")
    parser.add_argument("--output", default=None, help="Output PNG path (optional)")
    args = parser.parse_args()
    if args.demo:
        out = generate_receipt(DEMO_DATA, Path(args.output) if args.output else None)
        print(f"✓ Demo receipt saved: {out}")
    elif args.json:
        data = ReceiptData.from_json(args.json)
        out = generate_receipt(data, Path(args.output) if args.output else None)
        print(f"✓ Receipt saved: {out}")
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
