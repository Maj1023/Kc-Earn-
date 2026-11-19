'use strict';

// ISO 3166-1 alpha-2 country codes and ISO 4217 currencies for Africa.
// Country and currency are account metadata only; this does not imply that
// earning inventory or withdrawals are available in every market.
const AFRICAN_COUNTRIES = Object.freeze([
  ['DZ','Algeria','DZD'],['AO','Angola','AOA'],['BJ','Benin','XOF'],
  ['BW','Botswana','BWP'],['BF','Burkina Faso','XOF'],['BI','Burundi','BIF'],
  ['CV','Cabo Verde','CVE'],['CM','Cameroon','XAF'],['CF','Central African Republic','XAF'],
  ['TD','Chad','XAF'],['KM','Comoros','KMF'],['CG','Republic of the Congo','XAF'],
  ['CD','Democratic Republic of the Congo','CDF'],['CI',"Côte d’Ivoire",'XOF'],
  ['DJ','Djibouti','DJF'],['EG','Egypt','EGP'],['GQ','Equatorial Guinea','XAF'],
  ['ER','Eritrea','ERN'],['SZ','Eswatini','SZL'],['ET','Ethiopia','ETB'],
  ['GA','Gabon','XAF'],['GM','Gambia','GMD'],['GH','Ghana','GHS'],
  ['GN','Guinea','GNF'],['GW','Guinea-Bissau','XOF'],['KE','Kenya','KES'],
  ['LS','Lesotho','LSL'],['LR','Liberia','LRD'],['LY','Libya','LYD'],
  ['MG','Madagascar','MGA'],['MW','Malawi','MWK'],['ML','Mali','XOF'],
  ['MR','Mauritania','MRU'],['MU','Mauritius','MUR'],['MA','Morocco','MAD'],
  ['MZ','Mozambique','MZN'],['NA','Namibia','NAD'],['NE','Niger','XOF'],
  ['NG','Nigeria','NGN'],['RW','Rwanda','RWF'],['ST','São Tomé and Príncipe','STN'],
  ['SN','Senegal','XOF'],['SC','Seychelles','SCR'],['SL','Sierra Leone','SLE'],
  ['SO','Somalia','SOS'],['ZA','South Africa','ZAR'],['SS','South Sudan','SSP'],
  ['SD','Sudan','SDG'],['TZ','Tanzania','TZS'],['TG','Togo','XOF'],
  ['TN','Tunisia','TND'],['UG','Uganda','UGX'],['ZM','Zambia','ZMW'],
  ['ZW','Zimbabwe','ZWG']
].map(([code, name, currency]) => Object.freeze({ code, name, currency })));

const COUNTRY_BY_CODE = new Map(AFRICAN_COUNTRIES.map(country => [country.code, country]));

function getAfricanCountry(code) {
  if (typeof code !== 'string') return null;
  return COUNTRY_BY_CODE.get(code.trim().toUpperCase()) || null;
}

module.exports = { AFRICAN_COUNTRIES, getAfricanCountry };
