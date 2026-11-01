'use strict';
const { db, getSetting } = require('./db');

// Great-circle distance in km (Haversine).
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371.0088, rad = d => d * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
const round2 = n => Math.round(n * 100) / 100;

/**
 * Delivery quote.
 * distance_km = haversine * road_factor (straight line understates real roads)
 * modes:
 *   distance  : base_fee + km * price_per_km
 *   city      : the admin's fixed price for the customer's city
 *   city_base : city fee used as the base:  city_fee + km * price_per_km
 *   highest   : max(distance formula, city fee)  (default: the formula, never below the city's price)
 */
function quote(lat, lng, cityId) {
  const storeLat = +getSetting('store_lat'), storeLng = +getSetting('store_lng');
  const base = +getSetting('base_fee'), perKm = +getSetting('price_per_km');
  const factor = +getSetting('road_factor') || 1, mode = getSetting('pricing_mode');
  const km = round2(haversineKm(storeLat, storeLng, lat, lng) * factor);
  const city = cityId ? db.prepare('SELECT id,name,delivery_fee FROM cities WHERE id=?').get(cityId) : null;
  const cityFee = city ? city.delivery_fee : base;
  const distanceFee = base + km * perKm;
  let fee;
  switch (mode) {
    case 'distance': fee = distanceFee; break;
    case 'city': fee = cityFee; break;

    case 'city_base': fee = cityFee + km * perKm; break;
    default: fee = Math.max(distanceFee, cityFee);
  }
  return { distance_km: km, delivery_fee: round2(fee), mode, base_fee: base, price_per_km: perKm,
           city_fee: city ? city.delivery_fee : null, city: city ? city.name : null };
}
module.exports = { haversineKm, quote };
