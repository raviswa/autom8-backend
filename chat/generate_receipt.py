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

def default_footer_for_service(service_type: str) -> str:
    st = (service_type or "").replace("-", "_").lower()
    if st == "takeaway":
        return "Thanks! Visit Again."
    if st == "delivery":
        return "Thank you! We hope to serve you again."
    if st == "reserve_table":
        return "We look forward to welcoming you!"
    return "Thank you for dining with us!"


# Item table column anchors (px from left)
_COL_QTY   = 248
_COL_PRICE = 308
_COL_AMT   = RECEIPT_WIDTH - PADDING


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
    def from_cart(cls, cart: dict):
        return [
            cls(name=line["title"], qty=line["qty"], unit_price=line["unit_price"])
            for item_id, line in cart.items()
        ]

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
    restaurant_fssai: str = ""
    restaurant_sac: str = "996331"   # SAC 996331 — restaurant / catering services
    restaurant_tagline: str = ""     # e.g. franchise line under the name
    restaurant_wa_number: str = ""
    restaurant_website: str = ""    # e.g. "https://munafe.in"

    # ── Order meta ─────────────────────────────────────────────────────────
    token_number: str = ""
    table_number: str = ""
    service_type: str = "dine_in"
    order_datetime: str = ""         # legacy display string
    order_date: str = ""             # dd/mm/yy
    order_time: str = ""             # HH:MM (24h)
    receipt_number: str = ""
    bill_number: str = ""
    cashier_name: str = ""

    # ── Customer ───────────────────────────────────────────────────────────
    customer_name: str = ""
    customer_phone: str = ""
    delivery_address: str = ""

    # ── Items ──────────────────────────────────────────────────────────────
    items: list[LineItem] = field(default_factory=list)

    # ── Financials ─────────────────────────────────────────────────────────
    gst_rate: float = 5.0
    gst_inclusive: bool = False
    parcel_charge: float = 0.0
    delivery_charge: float = 0.0
    discount: float = 0.0
    discount_label: str = "Discount"
    payment_mode: str = "Cash"
    round_to_integer: bool = True    # Indian retail bills round grand total to ₹

    # ── Extras ─────────────────────────────────────────────────────────────
    special_notes: str = ""
    footer_message: str = ""
    receipt_url: str = ""              # if set, QR links here; else falls back to WA reorder

    def __post_init__(self):
        now = datetime.now(ZoneInfo("Asia/Kolkata"))
        if not self.order_date:
            self.order_date = now.strftime("%d/%m/%y")
        if not self.order_time:
            self.order_time = now.strftime("%H:%M")
        if not self.order_datetime:
            self.order_datetime = now.strftime("%d %b %Y, %I:%M %p")
        if not self.bill_number and self.receipt_number:
            self.bill_number = self.receipt_number
        if not self.footer_message:
            self.footer_message = default_footer_for_service(self.service_type)

    @property
    def total_qty(self) -> int:
        return sum(max(1, int(i.qty or 1)) for i in self.items)

    @property
    def items_subtotal(self) -> float:
        return round(sum(i.total for i in self.items), 2)

    @property
    def taxable_amount(self) -> float:
        base = self.items_subtotal + self.parcel_charge + self.delivery_charge
        if self.gst_inclusive and self.gst_rate > 0:
            return round(base / (1 + self.gst_rate / 100), 2)
        return round(base, 2)

    @property
    def gst_amount(self) -> float:
        if self.gst_inclusive and self.gst_rate > 0:
            return round(self.taxable_amount * self.gst_rate / 100, 2)
        return round(self.taxable_amount * self.gst_rate / 100, 2)

    @property
    def cgst(self) -> float:
        return round(self.gst_amount / 2, 2)

    @property
    def sgst(self) -> float:
        return round(self.gst_amount / 2, 2)

    @property
    def pre_gst_total(self) -> float:
        """Subtotal before GST (items + parcel + delivery)."""
        return self.taxable_amount

    @property
    def grand_total_unrounded(self) -> float:
        base = self.taxable_amount + self.gst_amount
        return round(base - self.discount, 2)

    @property
    def grand_total(self) -> float:
        raw = self.grand_total_unrounded
        if self.round_to_integer:
            return float(round(raw))
        return raw

    @property
    def round_off(self) -> float:
        if not self.round_to_integer:
            return 0.0
        return round(self.grand_total - self.grand_total_unrounded, 2)

    @classmethod
    def from_booking_session(cls, session_state: dict, cart: dict, restaurant: dict) -> "ReceiptData":
        service_type = session_state.get("service_type", "dine_in")
        return cls(
            restaurant_name=restaurant.get("name", ""),
            restaurant_tagline=restaurant.get("receipt_tagline") or "",
            restaurant_fssai=restaurant.get("fssai_license") or "",
            restaurant_sac=restaurant.get("sac_code") or "996331",
            restaurant_wa_number=restaurant.get("whatsapp_number", ""),
            restaurant_gstin=restaurant.get("gstin", ""),
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

    def _item_row(self, name: str, qty: int, unit_price: float, amount: float):
        """Four-column line: Item | Qty | Price | Amount."""
        font = self.f_small
        name_show = name if len(name) <= 22 else name[:20] + "…"
        self.draw.text((PADDING, self.y), name_show, fill=COLOR_DARK, font=font)
        self.draw.text((_COL_QTY, self.y), str(qty), fill=COLOR_DARK, font=font)
        price_txt = f"{unit_price:.2f}" if unit_price > 0 else ""
        amt_txt = f"{amount:.2f}" if amount > 0 else ""
        self.draw.text((_COL_PRICE, self.y), price_txt, fill=COLOR_DARK, font=self.f_mono)
        tw = self._tw(amt_txt, self.f_mono)
        self.draw.text((_COL_AMT - tw, self.y), amt_txt, fill=COLOR_DARK, font=self.f_mono)
        self.y += LINE_SPACING - 4

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
        self._center(d.restaurant_name.upper(), self.f_title, COLOR_DARK)
        if d.restaurant_tagline:
            self._center(d.restaurant_tagline, self.f_small, COLOR_MID)
        if d.restaurant_address:
            for line in d.restaurant_address.replace(",", "\n").split("\n"):
                line = line.strip()
                if line:
                    self._center(line, self.f_small, COLOR_LIGHT)
        if d.restaurant_phone:
            phones = d.restaurant_phone.replace(",", " / ")
            self._center(f"Phone: {phones}", self.f_small, COLOR_LIGHT)
        if d.restaurant_gstin:
            self._center(f"GSTNO-{d.restaurant_gstin}", self.f_small, COLOR_MID)
        reg_parts = []
        if d.restaurant_fssai:
            reg_parts.append(f"FSSAI LICENSE NO:{d.restaurant_fssai}")
        if d.restaurant_sac:
            reg_parts.append(f"SAC {d.restaurant_sac}")
        if reg_parts:
            self._center(" | ".join(reg_parts), self.f_small, COLOR_LIGHT)
        if d.restaurant_website:
            self._center(d.restaurant_website, self.f_small, COLOR_GREEN)
        self._gap(4)

    def _section_order_meta(self):
        d = self.data
        self._divider("solid")
        svc_labels = {
            "dine_in":       "Dine In",
            "takeaway":      "Take Away",
            "delivery":      "Delivery",
            "reserve_table": "Reservation",
        }
        svc_label = svc_labels.get(d.service_type, d.service_type.replace("_", " ").title())

        if d.customer_name:
            self._two_col("Name:", d.customer_name, font_r=self.f_bold)
        self._two_col("Date:", d.order_date)
        self._two_col("Time:", d.order_time, color_r=COLOR_MID)
        # Service type on the right, like printed POS bills
        self.draw.text((PADDING, self.y), "Order type:", fill=COLOR_MID, font=self.f_small)
        tw = self._tw(svc_label, self.f_bold)
        self.draw.text((RECEIPT_WIDTH - PADDING - tw, self.y), svc_label,
                       fill=COLOR_DARK, font=self.f_bold)
        self.y += LINE_SPACING
        if d.cashier_name:
            self._two_col("Cashier:", d.cashier_name)
        if d.bill_number:
            self._two_col("Bill No.:", str(d.bill_number), font_r=self.f_mono)
        if d.token_number:
            self._two_col("Token No.:", str(d.token_number), bold_right=True,
                          color_r=COLOR_DARK, font_r=self.f_bold)
        if d.table_number:
            self._two_col("Table:", str(d.table_number))

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
        # Column headers
        self.draw.text((PADDING, self.y), "Item", fill=COLOR_MID, font=self.f_bold)
        self.draw.text((_COL_QTY, self.y), "Qty.", fill=COLOR_MID, font=self.f_bold)
        self.draw.text((_COL_PRICE, self.y), "Price", fill=COLOR_MID, font=self.f_bold)
        tw = self._tw("Amount", self.f_bold)
        self.draw.text((_COL_AMT - tw, self.y), "Amount", fill=COLOR_MID, font=self.f_bold)
        self.y += LINE_SPACING - 2
        self._divider("dashed", gap=4)
        for item in d.items:
            self._item_row(item.name, item.qty, item.unit_price, item.total)
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
        if d.items:
            self._two_col("Total Qty:", str(d.total_qty), color_l=COLOR_MID, color_r=COLOR_MID)
        if d.items and any(i.unit_price > 0 for i in d.items):
            self._two_col("Sub Total:", f"{d.pre_gst_total:.2f}",
                          color_l=COLOR_MID, color_r=COLOR_MID, font_r=self.f_mono)
        if d.parcel_charge > 0:
            self._two_col("Parcel / packaging:", f"{d.parcel_charge:.2f}",
                          color_l=COLOR_MID, color_r=COLOR_MID, font_r=self.f_mono)
        if d.delivery_charge > 0:
            self._two_col("Delivery charge:", f"{d.delivery_charge:.2f}",
                          color_l=COLOR_MID, color_r=COLOR_MID, font_r=self.f_mono)
        if d.gst_rate > 0 and d.gst_amount > 0:
            half = d.gst_rate / 2
            self._two_col(f"CGST@{half:.1f}%:", f"{d.cgst:.2f}",
                          color_l=COLOR_MID, color_r=COLOR_MID, font_r=self.f_mono)
            self._two_col(f"SGST@{half:.1f}%:", f"{d.sgst:.2f}",
                          color_l=COLOR_MID, color_r=COLOR_MID, font_r=self.f_mono)
        if d.discount > 0:
            self._two_col(d.discount_label, f"- {d.discount:.2f}",
                          color_l=COLOR_MID, color_r=COLOR_MID, font_r=self.f_mono)
        if d.round_to_integer and abs(d.round_off) >= 0.01:
            sign = "+" if d.round_off > 0 else ""
            self._two_col("Round off:", f"{sign}{d.round_off:.2f}",
                          color_l=COLOR_MID, color_r=COLOR_MID, font_r=self.f_mono)
        self._divider("solid", gap=4)
        grand_txt = f"₹ {d.grand_total:.2f}" if not d.round_to_integer else f"₹ {d.grand_total:.0f}.00"
        self._two_col("Grand Total:", grand_txt,
                      font_l=self.f_heading, font_r=self.f_heading,
                      color_r=COLOR_DARK, bold_right=True)
        self._two_col("Payment mode:", d.payment_mode,
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
        self._gap(8)
        self._center(self.data.footer_message, self.f_body, COLOR_DARK)
        self._gap(6)
        self._center("Invoice", self.f_small, COLOR_LIGHT)
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

def restaurant_receipt_fields(restaurant: dict) -> dict:
    """Map restaurants row → ReceiptData restaurant_* kwargs."""
    if not restaurant:
        return {}
    return {
        "restaurant_name":    restaurant.get("name") or restaurant.get("display_name") or "",
        "restaurant_tagline": restaurant.get("receipt_tagline") or "",
        "restaurant_address": restaurant.get("address") or "",
        "restaurant_phone":   restaurant.get("phone") or "",
        "restaurant_gstin":   restaurant.get("gstin") or "",
        "restaurant_fssai":   restaurant.get("fssai_license") or "",
        "restaurant_sac":     restaurant.get("sac_code") or "996331",
        "restaurant_wa_number": restaurant.get("whatsapp_number") or "",
        "restaurant_website": restaurant.get("website") or "",
    }


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
    restaurant_name="Sukabala Foods Veg",
    restaurant_tagline="(Franchisee of Sangeetha's Desi Mane)",
    restaurant_address="No. 93 Arcot Road, Virugambakkam, Chennai-92",
    restaurant_phone="044 42697888, 7823958669",
    restaurant_gstin="33ADVFS6781J1Z7",
    restaurant_fssai="12419002004097",
    restaurant_sac="996331",
    restaurant_wa_number="919500996033",
    token_number="1644",
    service_type="takeaway",
    order_date="25/06/26",
    order_time="22:00",
    bill_number="21256",
    cashier_name="VENKADESAN",
    customer_name="Guest",
    items=[
        LineItem("Kal Dosa (2pcs)", qty=1, unit_price=135.0),
        LineItem("Idly (1pc)",      qty=3, unit_price=30.0),
        LineItem("Beeda",           qty=3, unit_price=14.28),
    ],
    gst_rate=5.0,
    gst_inclusive=False,
    payment_mode="Cash",
    footer_message="Thanks! Visit Again.",
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
