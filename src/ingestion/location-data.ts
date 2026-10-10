/**
 * Reference data for the US-job filter (job-location.ts). Names are matched as
 * lowercase, accent-free word sequences, so "São Paulo" is written "sao paulo".
 */

/** US states (and DC) by postal code. */
export const US_STATES: Readonly<Record<string, string>> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho',
  IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
  OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia',
};

/**
 * State names that are not proof of a US location on their own (Georgia is also
 * a country, Washington a common surname); they count only after a known city
 * ("Atlanta, Georgia") or in a phrase such as "Washington State".
 */
export const AMBIGUOUS_STATE_NAMES: ReadonlySet<string> = new Set(['georgia', 'washington']);

/**
 * Known US cities and the states they are paired with ("Austin, TX", "Austin,
 * Texas"). A city counts only next to one of its states, so a person's name
 * ("Austin") or an English word after a city ("Nashville in…") never does.
 */
export const US_CITIES: Readonly<Record<string, string>> = {
  'New York': 'NY', 'Brooklyn': 'NY', 'Manhattan': 'NY,KS', 'Queens': 'NY', 'Long Island City': 'NY',
  'Buffalo': 'NY', 'Rochester': 'NY,MN', 'Albany': 'NY', 'Syracuse': 'NY', 'Yonkers': 'NY', 'White Plains': 'NY',
  'Los Angeles': 'CA', 'San Francisco': 'CA', 'San Diego': 'CA', 'San Jose': 'CA', 'Sacramento': 'CA',
  'Oakland': 'CA', 'Fresno': 'CA', 'Long Beach': 'CA', 'Irvine': 'CA', 'Anaheim': 'CA', 'Santa Ana': 'CA',
  'Riverside': 'CA', 'Bakersfield': 'CA', 'Stockton': 'CA', 'Chula Vista': 'CA', 'Fremont': 'CA',
  'Santa Clara': 'CA', 'Sunnyvale': 'CA', 'Palo Alto': 'CA', 'Mountain View': 'CA', 'Menlo Park': 'CA',
  'Redwood City': 'CA', 'San Mateo': 'CA', 'Cupertino': 'CA', 'Berkeley': 'CA', 'Pasadena': 'CA,TX',
  'Santa Monica': 'CA', 'Burbank': 'CA', 'Torrance': 'CA', 'Costa Mesa': 'CA', 'Newport Beach': 'CA',
  'Carlsbad': 'CA', 'El Segundo': 'CA', 'Culver City': 'CA', 'Walnut Creek': 'CA', 'Pleasanton': 'CA',
  'San Ramon': 'CA', 'Emeryville': 'CA', 'South San Francisco': 'CA', 'Foster City': 'CA', 'Milpitas': 'CA',
  'Los Gatos': 'CA', 'Santa Barbara': 'CA', 'Roseville': 'CA', 'Thousand Oaks': 'CA', 'Glendale': 'CA,AZ',
  'Huntington Beach': 'CA', 'Santa Clarita': 'CA', 'Dublin': 'CA,OH',
  'Chicago': 'IL', 'Evanston': 'IL', 'Naperville': 'IL', 'Schaumburg': 'IL', 'Oak Brook': 'IL', 'Deerfield': 'IL',
  'Aurora': 'IL,CO', 'Springfield': 'IL,MO,MA',
  'Houston': 'TX', 'San Antonio': 'TX', 'Dallas': 'TX', 'Austin': 'TX', 'Fort Worth': 'TX', 'El Paso': 'TX',
  'Arlington': 'TX,VA', 'Corpus Christi': 'TX', 'Plano': 'TX', 'Irving': 'TX', 'Frisco': 'TX', 'McKinney': 'TX',
  'Lubbock': 'TX', 'Laredo': 'TX', 'Garland': 'TX', 'Amarillo': 'TX', 'Grand Prairie': 'TX', 'The Woodlands': 'TX',
  'Phoenix': 'AZ', 'Tucson': 'AZ', 'Mesa': 'AZ', 'Chandler': 'AZ', 'Scottsdale': 'AZ', 'Gilbert': 'AZ', 'Tempe': 'AZ',
  'Philadelphia': 'PA', 'Pittsburgh': 'PA', 'Harrisburg': 'PA', 'Allentown': 'PA', 'Lancaster': 'PA',
  'King of Prussia': 'PA', 'Conshohocken': 'PA', 'Malvern': 'PA',
  'Jacksonville': 'FL', 'Miami': 'FL', 'Tampa': 'FL', 'Orlando': 'FL', 'Fort Lauderdale': 'FL', 'Tallahassee': 'FL',
  'St Petersburg': 'FL', 'Saint Petersburg': 'FL', 'Hialeah': 'FL', 'Boca Raton': 'FL', 'West Palm Beach': 'FL',
  'Sarasota': 'FL', 'Naples': 'FL', 'Fort Myers': 'FL', 'Gainesville': 'FL', 'Coral Gables': 'FL', 'Doral': 'FL',
  'Columbus': 'OH,GA', 'Cleveland': 'OH', 'Cincinnati': 'OH', 'Toledo': 'OH', 'Akron': 'OH', 'Dayton': 'OH', 'Mason': 'OH',
  'Charlotte': 'NC', 'Raleigh': 'NC', 'Durham': 'NC', 'Greensboro': 'NC', 'Winston Salem': 'NC', 'Cary': 'NC',
  'Chapel Hill': 'NC', 'Morrisville': 'NC', 'Asheville': 'NC', 'Fayetteville': 'NC,AR',
  'Greenville': 'SC,NC', 'Wilmington': 'DE,NC', 'Charleston': 'SC,WV', 'Columbia': 'SC,MO,MD',
  'Indianapolis': 'IN', 'Fort Wayne': 'IN', 'Carmel': 'IN', 'Fishers': 'IN', 'Bloomington': 'IN,MN',
  'Seattle': 'WA', 'Spokane': 'WA', 'Tacoma': 'WA', 'Bellevue': 'WA', 'Redmond': 'WA', 'Kirkland': 'WA',
  'Everett': 'WA', 'Vancouver': 'WA',
  'Denver': 'CO', 'Colorado Springs': 'CO', 'Boulder': 'CO', 'Broomfield': 'CO', 'Englewood': 'CO',
  'Lakewood': 'CO', 'Fort Collins': 'CO',
  'Washington': 'DC',
  'Boston': 'MA', 'Cambridge': 'MA', 'Somerville': 'MA', 'Waltham': 'MA', 'Worcester': 'MA', 'Burlington': 'MA,VT',
  'Nashville': 'TN', 'Memphis': 'TN', 'Knoxville': 'TN', 'Chattanooga': 'TN', 'Brentwood': 'TN', 'Franklin': 'TN',
  'Murfreesboro': 'TN',
  'Detroit': 'MI', 'Grand Rapids': 'MI', 'Ann Arbor': 'MI', 'Dearborn': 'MI', 'Troy': 'MI', 'Southfield': 'MI',
  'Oklahoma City': 'OK', 'Tulsa': 'OK',
  'Portland': 'OR,ME', 'Salem': 'OR,MA', 'Augusta': 'GA,ME',
  'Las Vegas': 'NV', 'North Las Vegas': 'NV', 'Henderson': 'NV', 'Reno': 'NV',
  'Louisville': 'KY', 'Lexington': 'KY',
  'Baltimore': 'MD', 'Bethesda': 'MD', 'Rockville': 'MD', 'Annapolis': 'MD', 'Silver Spring': 'MD',
  'Milwaukee': 'WI', 'Madison': 'WI', 'Green Bay': 'WI',
  'Albuquerque': 'NM', 'Santa Fe': 'NM',
  'Atlanta': 'GA', 'Alpharetta': 'GA', 'Marietta': 'GA', 'Savannah': 'GA', 'Athens': 'GA', 'Sandy Springs': 'GA',
  'Duluth': 'GA,MN',
  'Kansas City': 'MO,KS', 'St Louis': 'MO', 'Saint Louis': 'MO', 'Chesterfield': 'MO', 'Clayton': 'MO',
  'Omaha': 'NE', 'Lincoln': 'NE',
  'Minneapolis': 'MN', 'St Paul': 'MN', 'Saint Paul': 'MN', 'Minnetonka': 'MN', 'Eden Prairie': 'MN', 'Edina': 'MN',
  'Virginia Beach': 'VA', 'Norfolk': 'VA', 'Chesapeake': 'VA', 'Richmond': 'VA', 'Herndon': 'VA', 'Reston': 'VA',
  'McLean': 'VA', 'Tysons': 'VA', 'Alexandria': 'VA', 'Fairfax': 'VA', 'Chantilly': 'VA',
  'New Orleans': 'LA', 'Baton Rouge': 'LA', 'Shreveport': 'LA',
  'Wichita': 'KS', 'Overland Park': 'KS', 'Lenexa': 'KS', 'Leawood': 'KS', 'Olathe': 'KS',
  'Honolulu': 'HI', 'Anchorage': 'AK', 'Boise': 'ID',
  'Salt Lake City': 'UT', 'Lehi': 'UT', 'Provo': 'UT', 'Draper': 'UT',
  'Des Moines': 'IA', 'Cedar Rapids': 'IA', 'Sioux Falls': 'SD', 'Fargo': 'ND', 'Billings': 'MT', 'Cheyenne': 'WY',
  'Birmingham': 'AL', 'Huntsville': 'AL', 'Montgomery': 'AL',
  'Little Rock': 'AR', 'Bentonville': 'AR', 'Rogers': 'AR', 'Jackson': 'MS',
  'Providence': 'RI', 'Stamford': 'CT', 'Hartford': 'CT', 'New Haven': 'CT', 'Greenwich': 'CT',
  'Newark': 'NJ,DE', 'Jersey City': 'NJ', 'Hoboken': 'NJ', 'Princeton': 'NJ', 'Morristown': 'NJ',
  'Manchester': 'NH',
};

/** Phrases that place a job in the US on their own (besides "United States", "USA", "U.S." and state names). */
export const US_PHRASES: Readonly<Record<string, string>> = {
  'united states of america': 'United States',
  'united states': 'United States',
  usa: 'United States',
  nyc: 'New York City',
  'new york city': 'New York City',
  'san francisco bay area': 'San Francisco Bay Area',
  'sf bay area': 'San Francisco Bay Area',
  'silicon valley': 'Silicon Valley',
  'new england': 'New England',
  'washington state': 'Washington',
  'greater boston': 'Greater Boston',
  'greater chicago': 'Greater Chicago',
  'greater seattle': 'Greater Seattle',
  'greater philadelphia': 'Greater Philadelphia',
  'greater houston': 'Greater Houston',
  'dallas fort worth': 'Dallas-Fort Worth',
};

/**
 * Countries, regions and major cities outside the US. Names that are common
 * given names or US places ("Jordan", "Chad", "Georgia", "Cambridge",
 * "Richmond", "Athens"…) are left out on purpose.
 */
export const NON_US_PLACES: readonly string[] = [
  // Countries and common short forms
  'afghanistan', 'albania', 'algeria', 'andorra', 'angola', 'argentina', 'armenia', 'australia', 'austria',
  'azerbaijan', 'bahamas', 'bahrain', 'bangladesh', 'barbados', 'belarus', 'belgium', 'belize', 'benin', 'bhutan',
  'bolivia', 'bosnia', 'botswana', 'brazil', 'brasil', 'brunei', 'bulgaria', 'burkina faso', 'burundi', 'cambodia',
  'cameroon', 'canada', 'cape verde', 'chile', 'china', 'colombia', 'congo', 'costa rica', 'croatia', 'cuba',
  'cyprus', 'czech republic', 'czechia', 'denmark', 'djibouti', 'dominican republic', 'ecuador', 'egypt',
  'el salvador', 'eritrea', 'estonia', 'eswatini', 'ethiopia', 'fiji', 'finland', 'france', 'gabon', 'gambia',
  'germany', 'deutschland', 'ghana', 'greece', 'guatemala', 'guinea', 'guyana', 'haiti', 'honduras', 'hong kong',
  'hungary', 'iceland', 'india', 'indonesia', 'iran', 'iraq', 'ireland', 'israel', 'italy', 'ivory coast',
  'cote d ivoire', 'japan', 'kazakhstan', 'kenya', 'kosovo', 'kuwait', 'kyrgyzstan', 'laos', 'latvia', 'lebanon',
  'lesotho', 'liberia', 'libya', 'liechtenstein', 'lithuania', 'luxembourg', 'macau', 'madagascar', 'malawi',
  'malaysia', 'maldives', 'malta', 'mauritania', 'mauritius', 'mexico', 'moldova', 'monaco', 'mongolia',
  'montenegro', 'morocco', 'mozambique', 'myanmar', 'namibia', 'nepal', 'netherlands', 'new zealand', 'nicaragua',
  'nigeria', 'north macedonia', 'norway', 'oman', 'pakistan', 'palestine', 'panama', 'papua new guinea', 'paraguay',
  'peru', 'philippines', 'poland', 'portugal', 'qatar', 'romania', 'russia', 'rwanda', 'saudi arabia', 'ksa',
  'senegal', 'serbia', 'seychelles', 'sierra leone', 'singapore', 'slovakia', 'slovenia', 'somalia', 'south africa',
  'south korea', 'korea', 'spain', 'sri lanka', 'sudan', 'suriname', 'sweden', 'switzerland', 'syria', 'taiwan',
  'tajikistan', 'tanzania', 'thailand', 'togo', 'trinidad', 'tunisia', 'turkey', 'turkiye', 'turkmenistan',
  'uganda', 'ukraine', 'united arab emirates', 'uae', 'united kingdom', 'uk', 'great britain', 'britain', 'england',
  'scotland', 'wales', 'northern ireland', 'uruguay', 'uzbekistan', 'venezuela', 'vietnam', 'viet nam', 'yemen',
  'zambia', 'zimbabwe',
  // Regions used for job territories
  'emea', 'apac', 'apj', 'latam', 'anz', 'dach', 'gcc', 'mena', 'benelux', 'nordics',
  // Provinces, states and regions that LinkedIn and posts use instead of a country
  'ontario', 'quebec', 'british columbia', 'alberta', 'manitoba', 'nova scotia', 'new south wales', 'queensland',
  'karnataka', 'maharashtra', 'telangana', 'tamil nadu', 'haryana', 'uttar pradesh', 'west bengal', 'gujarat',
  'kerala', 'metro manila', 'calabarzon',
  // Major cities
  'london', 'toronto', 'montreal', 'vancouver', 'calgary', 'ottawa', 'edmonton', 'winnipeg', 'mississauga',
  'bangalore', 'bengaluru', 'mumbai', 'delhi', 'new delhi', 'gurgaon', 'gurugram', 'noida', 'hyderabad', 'pune',
  'chennai', 'kolkata', 'ahmedabad', 'jaipur', 'kochi', 'chandigarh', 'indore', 'coimbatore',
  'berlin', 'munich', 'frankfurt', 'hamburg', 'cologne', 'dusseldorf', 'stuttgart', 'paris', 'lyon', 'amsterdam',
  'rotterdam', 'brussels', 'antwerp', 'dublin', 'cork', 'madrid', 'barcelona', 'lisbon', 'porto', 'milan', 'rome',
  'turin', 'zurich', 'geneva', 'basel', 'vienna', 'prague', 'warsaw', 'krakow', 'wroclaw', 'budapest', 'bucharest',
  'sofia', 'istanbul', 'ankara', 'stockholm', 'gothenburg', 'copenhagen', 'oslo', 'helsinki', 'tallinn', 'riga',
  'vilnius', 'kyiv', 'kiev', 'moscow', 'tel aviv', 'jerusalem', 'dubai', 'abu dhabi', 'sharjah', 'riyadh', 'jeddah',
  'dammam', 'doha', 'manama', 'muscat', 'kuwait city', 'cairo', 'casablanca', 'lagos', 'abuja', 'nairobi', 'accra',
  'johannesburg', 'cape town', 'durban', 'kampala', 'kigali', 'addis ababa', 'kuala lumpur', 'jakarta', 'bangkok',
  'manila', 'makati', 'taguig', 'cebu', 'ho chi minh', 'hanoi', 'tokyo', 'osaka', 'seoul', 'beijing', 'shanghai',
  'shenzhen', 'guangzhou', 'taipei', 'karachi', 'lahore', 'islamabad', 'dhaka', 'colombo', 'kathmandu', 'sydney',
  'melbourne', 'brisbane', 'perth', 'adelaide', 'canberra', 'auckland', 'mexico city', 'guadalajara', 'monterrey',
  'sao paulo', 'rio de janeiro', 'buenos aires', 'bogota', 'medellin', 'lima', 'santiago', 'montevideo',
  'edinburgh', 'glasgow', 'belfast', 'leeds', 'manchester', 'birmingham', 'oxford',
];
