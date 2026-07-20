/**
 * Shiprocket serviceability helpers (shared by webcart + settings compare tool).
 */

async function fetchShiprocketCourierOptions({
  apiKey,
  pickupPincode,
  deliveryPincode,
  weightKg = 0.5,
  limit = 5,
}) {
  if (!apiKey || !pickupPincode || !deliveryPincode) {
    return { cheapest: null, couriers: [], error: 'Missing Shiprocket credentials or pincode.' };
  }
  const weight = Math.max(0.01, Number(weightKg) || 0.5);
  try {
    const url = new URL('https://apiv2.shiprocket.in/v1/external/courier/serviceability/');
    url.searchParams.set('pickup_postcode', pickupPincode);
    url.searchParams.set('delivery_postcode', deliveryPincode);
    url.searchParams.set('weight', String(weight));
    url.searchParams.set('cod', '0');

    const rateRes = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const data = await rateRes.json().catch(() => ({}));
    if (!rateRes.ok) {
      const message = data?.message || `Shiprocket error ${rateRes.status}`;
      return { cheapest: null, couriers: [], error: message };
    }

    const raw = data?.data?.available_courier_companies || data?.data || [];
    const list = Array.isArray(raw) ? raw : [];
    const couriers = list
      .map((row) => ({
        name: String(row.courier_name || row.courier_company || row.name || 'Courier').trim(),
        rate: Number(row.rate || row.freight_charge || row.charge || 0),
        etd: row.etd || row.estimated_delivery_days || null,
      }))
      .filter((row) => row.rate > 0)
      .sort((a, b) => a.rate - b.rate)
      .slice(0, Math.max(1, Math.min(10, Number(limit) || 5)));

    return {
      cheapest: couriers.length ? couriers[0].rate : null,
      couriers,
      error: couriers.length ? null : 'No couriers available for this route/weight.',
    };
  } catch (err) {
    return { cheapest: null, couriers: [], error: err.message || 'Shiprocket request failed.' };
  }
}

async function fetchShiprocketCheapestRate(opts) {
  const result = await fetchShiprocketCourierOptions(opts);
  return result.cheapest;
}

module.exports = {
  fetchShiprocketCourierOptions,
  fetchShiprocketCheapestRate,
};
