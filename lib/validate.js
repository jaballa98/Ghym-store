'use strict';
const EMAIL_DOMAINS = ['gmail.com', 'icloud.com'];
const isEmail = e => {
  const m = /^[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})$/.exec(String(e || '').trim());
  return !!m && EMAIL_DOMAINS.includes(m[1].toLowerCase());
};
const isPhone = p => /^\+?[0-9]{7,15}$/.test(String(p || '').replace(/[\s-]/g, ''));
const cleanPhone = p => String(p || '').replace(/[\s-]/g, '');
const isUsername = u => /^[A-Za-z][A-Za-z0-9_.]{2,29}$/.test(String(u || ''));
const isLat = n => Number.isFinite(n) && n >= -90 && n <= 90;
const isLng = n => Number.isFinite(n) && n >= -180 && n <= 180;

function validateRegistration(b, cityExists, usernameTaken) {
  const e = {};
  const name = s => typeof s === 'string' && s.trim().length >= 2 && s.trim().length <= 50;
  if (!name(b.first_name)) e.first_name = 'Enter your first name (2 to 50 characters).';
  if (!name(b.last_name)) e.last_name = 'Enter your last name (2 to 50 characters).';
  if (!cityExists(+b.city_id)) e.city_id = 'Choose a city from the list.';
  if (!isPhone(b.phone1)) e.phone1 = 'Enter a valid phone number (7 to 15 digits).';
  if (b.phone2 && !isPhone(b.phone2)) e.phone2 = 'Second phone number is not valid.';
  if (!isEmail(b.email)) e.email = 'Use a Gmail or iCloud address (name@gmail.com or name@icloud.com).';
  if (!isLat(+b.lat) || !isLng(+b.lng) || b.lat === '' || b.lng === '' || b.lat == null || b.lng == null)
    e.location = 'Pin your delivery location on the map.';
  if (!isUsername(b.username)) e.username = 'Username: 3 to 30 characters, start with a letter, use letters, numbers, _ or .';
  else if (usernameTaken(b.username)) e.username = 'That username is already taken.';
  if (typeof b.password !== 'string' || b.password.length < 8) e.password = 'Password must be at least 8 characters.';
  if (b.password !== b.confirm_password) e.confirm_password = 'Passwords do not match.';
  return e;
}
module.exports = { isEmail, isPhone, cleanPhone, isUsername, isLat, isLng, validateRegistration };
