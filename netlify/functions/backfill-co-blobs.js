/**
 * backfill-co-blobs.js — ONE-TIME USE, safe to delete after running
 *
 * The Colorado sites/techs added tonight were written directly into
 * index.html's source (which is why the dispatch app already shows them
 * correctly) and into Supabase -- but never into Netlify Blobs, which is
 * what the admin panel actually reads/writes. This backfills Blobs so
 * the admin panel's Locations/Technicians tabs show and can edit them too.
 *
 * Visit once in a browser:
 *   https://mcrdispatch.net/.netlify/functions/backfill-co-blobs?confirm=yes
 *
 * Safe to run more than once (merges rather than duplicates). Delete this
 * file from netlify/functions/ once you've confirmed the admin panel shows
 * the 73 CO locations and 5 CO technicians.
 */
const { getStore, connectLambda } = require("@netlify/blobs");

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  connectLambda(event);
  const confirm = (event.queryStringParameters || {}).confirm;
  if (confirm !== "yes") {
    return json(400, { error: "Add ?confirm=yes to the URL to run this backfill." });
  }

  const now = new Date().toISOString();
  const locations = {
    "CO1000": { code: "CO1000", state: "CO", name: "Arapahoe County - Littleton - CO1000 100", address: "5334 South Prince Street, Littleton, CO 80120", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1001": { code: "CO1001", state: "CO", name: "Arapahoe County - Aurora 1 - CO1001 101", address: "490 S. Chambers Road, Aurora, CO 80017", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1002": { code: "CO1002", state: "CO", name: "Arapahoe County - Centennial - CO1002 102", address: "6954 S. Lima St., Centennial, CO 80112", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1004": { code: "CO1004", state: "CO", name: "Mesa County - Grand Junction - CO1004 104", address: "200 S. Spruce Street, Grand Junction, CO 81501", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "BK", remote: false, updatedAt: now },
    "CO1007": { code: "CO1007", state: "CO", name: "Douglas County - Cottonwood King Soopers - CO1007 125", address: "17761 Cottonwood Dr., Cottonwood Plaza Shopping Ctr, Parker, CO 80134", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1008": { code: "CO1008", state: "CO", name: "Boulder County 30th Street King Soopers - CO1008 194", address: "1650 30th Street, Boulder, Colorado 80301", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1010": { code: "CO1010", state: "CO", name: "Boulder County - Main St King Soopers - CO1010 163", address: "2255 Main St. , Longmont, CO 80501", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1011": { code: "CO1011", state: "CO", name: "Adams County - Federal King Soopers - CO1011 149", address: "10351 Federal Blvd., Westminster, CO 80260", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "BK", remote: false, updatedAt: now },
    "CO1012": { code: "CO1012", state: "CO", name: "Adams County - 120th King Soopers - CO1012 148", address: "3801 E 120th Ave, Thornton, CO 80234", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1013": { code: "CO1013", state: "CO", name: "Adams County \\u2013 104th King Soopers - CO1013 126", address: "15051 E. 104th Ave., Reunion Marketplace Ctr, Commerce City, CO 80022", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1015": { code: "CO1015", state: "CO", name: "Broomfield County - Sheridan King Soopers - CO1015 151", address: "12167 Sheridan Blvd, Broomfield, CO 80020", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1016": { code: "CO1016", state: "CO", name: "Weld County - 10th King Soopers - CO1016 127", address: "6922 10th Street, Greeley, CO 80634", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1017": { code: "CO1017", state: "CO", name: "Weld County - Firestone King Soopers - CO1017 162", address: "6110 Firestone Blvd. Longmont, CO 80504", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1018": { code: "CO1018", state: "CO", name: "Weld County - 10th King Soopers 2 - CO1018 182", address: "6922 10th Street, Greeley, CO 80634", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1020": { code: "CO1020", state: "CO", name: "Larimer County - College King Soopers - CO1020 124", address: "1842 N. College Ave., Fort Collins, CO 80524", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1021": { code: "CO1021", state: "CO", name: "Larimer County \\u2013 Eagle King Soopers - CO1021 133", address: "1275 Eagle Dr, Thomson Valley Center, Loveland, CO 80537", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1022": { code: "CO1022", state: "CO", name: "El Paso County - Union Blvd - CO1022 112", address: "8830 N. Union Blvd., Colorado Springs, CO 80920", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "BH", remote: false, updatedAt: now },
    "CO1023": { code: "CO1023", state: "CO", name: "El Paso Co \\u2013 Safeway McLaughlin Road", address: "7655 McLaughlin Rd. Falcon, CO 80831", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1024": { code: "CO1024", state: "CO", name: "El Paso County - Centennial - CO1024 166", address: "200 South Cascade Ave, Suite 20, Colorado Springs, CO 80903", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "BH", remote: false, updatedAt: now },
    "CO1025": { code: "CO1025", state: "CO", name: "El Paso County - Powers - CO1025 121", address: "5650 Industrial Place, Colorado Springs, CO 80916", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "BK", remote: false, updatedAt: now },
    "CO1026": { code: "CO1026", state: "CO", name: "Jefferson County King Soopers - CO1026 128", address: "8031 Wadsworth Blvd, Market Square, Arvada, CO 80003", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1027": { code: "CO1027", state: "CO", name: "Jefferson County - Alameda King Soopers - CO1027 146", address: "7984 W Alameda Ave, Wadsworth & Alameda, Lakewood, CO 80229", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1028": { code: "CO1028", state: "CO", name: "Jefferson County - Ken Caryl King Soopers - CO1028 142", address: "11747 W Ken Caryl Ave, Littleton, CO 80127", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1029": { code: "CO1029", state: "CO", name: "Jefferson County - 38th Ave King Soopers - CO1029 144", address: "5301 W 38th Ave, Ridge Village, Wheat Ridge, CO 80212", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1030": { code: "CO1030", state: "CO", name: "La Plata County - Bayfield Town Hall CO1030 184", address: "1199 Bayfield Town Parkway, Bayfield, CO 81122", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1031": { code: "CO1031", state: "CO", name: "La Plata County - Main Street City Market - CO1031 140", address: "3130 Main St., Durango, CO 81303", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1033": { code: "CO1033", state: "CO", name: "Arapahoe County - Smokey Hill King Soopers - CO1033 122", address: "25701 E. Smoky Hill Road, Aurora, CO 80016", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1034": { code: "CO1034", state: "CO", name: "Arapahoe County - S Federal King Soopers - CO1034 123", address: "5050 South Federal Blvd., Englewood, CO 80110", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1035": { code: "CO1035", state: "CO", name: "Arapahoe County - Aurora 2 - CO1035 201", address: "490 S. Chambers Road, Aurora, CO 80017", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1036": { code: "CO1036", state: "CO", name: "Arapahoe County - Mississippi King Soopers - CO1036 132", address: "15250 E. Mississippi Ave, Village Green Plaza, Aurora, CO 80012", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1038": { code: "CO1038", state: "CO", name: "Arapahoe County - Hampden King Soopers - CO1038 178", address: "18211 E Hampden Ave, Aurora, CO 80013", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1039": { code: "CO1039", state: "CO", name: "Arapahoe County - Peoria King Soopers - CO1039 158", address: "3050 South Peoria Street, Aurora, CO 80014", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1041": { code: "CO1041", state: "CO", name: "Adams County - 62nd King Soopers - CO1041 147", address: "4850 E 62nd Ave, Commerce City, CO 80022", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1042": { code: "CO1042", state: "CO", name: "Pueblo County - Northern King Soopers - CO1042 134", address: "3050 West Northern Ave, South Side, Pueblo, CO 81005", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1043": { code: "CO1043", state: "CO", name: "Douglas County \\u2013 Wildcat King Soopers - CO1043 136", address: "2205 W Wildcat Reserve Pkwy, Highlands Ranch, CO 80129", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1044": { code: "CO1044", state: "CO", name: "Douglas County \\u2013 King Soopers Parker Stroh Ranch - CO1044 137", address: "12959 South Parker Road, Parker, CO 80134", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1045": { code: "CO1045", state: "CO", name: "Douglas County \\u2013 Promenade King Soopers - CO1045 138", address: "5544 Promenade Pkwy, Castle Rock, CO 80108", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1046": { code: "CO1046", state: "CO", name: "Fremont County - Fremont City Market - CO1046 139", address: "1703 Fremont Dr, Canon City, CO 81212", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1047": { code: "CO1047", state: "CO", name: "Mesa County - US 50 City Market - CO1047 168", address: "2770 US-50, Grand Junction, CO 81503", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1051": { code: "CO1051", state: "CO", name: "El Paso County - Stetson King Soopers - CO1051 145", address: "6030 Stetson Hills Blvd, Colorado Springs, CO 80923", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1052": { code: "CO1052", state: "CO", name: "El Paso County - Academy King Soopers - CO1052 150", address: "2910 S Academy Blvd, Hancock Plaza Shopping Center, Colorado Springs, CO 80916", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1053": { code: "CO1053", state: "CO", name: "Jefferson County - Conifer King Soopers - CO1053 143", address: "25637 Conifer Rd, Conifer, CO 80433", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1054": { code: "CO1054", state: "CO", name: "El Paso County - Baptist King Soopers - CO1054 154", address: "1070 W Baptist Road, Colorado Springs, CO 80921", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1055": { code: "CO1055", state: "CO", name: "El Paso County - Constitution King Soopers - CO1055 159", address: "7915 Constitution Ave, Colorado Springs , CO 80951", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1056": { code: "CO1056", state: "CO", name: "El Paso County - Austin Bluff King Soopers - CO1056 160", address: "3620 Austin Bluffs Pkwy, Colorado Springs , CO 80918", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1057": { code: "CO1057", state: "CO", name: "El Paso County Mesa Ridge Safeway - CO1057 183", address: "6925 Mesa Ridge Parkway, Fountain, CO 80817", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1059": { code: "CO1059", state: "CO", name: "Pueblo County - Safeway Market - CO1059 169", address: "1017 N Market Plaza, Pueblo, CO 81007", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1060": { code: "CO1060", state: "CO", name: "Douglas County - N Ridge King Soopers - CO1060 161", address: "750 N Ridge Rd., Castle Rock, CO\\u00a080104", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1061": { code: "CO1061", state: "CO", name: "Douglas County - University King Soopers - CO1061 164", address: "9551 S University Blvd. Highlands Ranch, CO 80126", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1062": { code: "CO1062", state: "CO", name: "Larimer County - JFK Pkwy King Soopers - CO1062 165", address: "4503 John F. Kennedy Parkway, Fort Collins , CO 80525", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1063": { code: "CO1063", state: "CO", name: "El Paso County - Citizens Square Hoku - CO1063 167", address: "1675 W. Garden of the Gods, Colorado Springs, CO 80907", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "BH", remote: false, updatedAt: now },
    "CO1064": { code: "CO1064", state: "CO", name: "Denver County - Regional Service Center - 5th Street -CO1064 215", address: "1351 5th St. Suite 100 Denver,CO 80204", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1066": { code: "CO1066", state: "CO", name: "Boulder County - South King Soopers - CO1066 173", address: "1375 East South Boulder Road, Louisville, CO 80027", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1067": { code: "CO1067", state: "CO", name: "Denver County - Speer King Soopers CO1067 174", address: "1331 Speer Boulevard, Denver, CO 80204", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1068": { code: "CO1068", state: "CO", name: "Denver County - S Colorado King Soopers CO1068 175", address: "2750 South Colorado Boulevard, Denver, CO 80222", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1069": { code: "CO1069", state: "CO", name: "Denver County - Quebec King Soopers CO1069 176", address: "2810 Quebec Street, Denver, CO 80207", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1070": { code: "CO1070", state: "CO", name: "Denver County - Quebec Safeway #400 CO1070 177", address: "200 Quebec Street, Denver, CO 80230", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1071": { code: "CO1071", state: "CO", name: "Summit County - City Market CO1071 179", address: "300 Dillon Ridge Road, Dillon, CO 80435", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1072": { code: "CO1072", state: "CO", name: "Denver County - Sheridan King Soopers CO1072 181", address: "3100 South Sheridan Boulevard, Denver, CO 80227", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1073": { code: "CO1073", state: "CO", name: "Adams County - First King Soopers #112 185", address: "1045 South 1st Street, Bennett, CO 80102", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1074": { code: "CO1074", state: "CO", name: "Arapahoe County - Leetsdale King Soopers CO1074 186", address: "4600 Leetsdale Dr, Glendale, CO 80246", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1075": { code: "CO1075", state: "CO", name: "Pueblo Co - US 50 Albertsons #816 CO1075 187", address: "1601 Hwy 50 W, Pueblo, CO 81008", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1076": { code: "CO1076", state: "CO", name: "Teller County - Goldhill City Market #1578 188", address: "777 Gold Hill Place South, Woodland Park, CO 80863", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1077": { code: "CO1077", state: "CO", name: "Garfield County - Carbondale City Market CO1077 189", address: "905 CO-133, Carbondale, CO 81623", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1078": { code: "CO1078", state: "CO", name: "Morgan County Platte Safeway CO1078 190", address: "620 West Platte Avenue, Fort Morgan, CO 80701", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1079": { code: "CO1079", state: "CO", name: "Grand Co - County Safeway #1568 CO1079 191", address: "40 County Rd 804, Fraser, CO 80442", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1080": { code: "CO1080", state: "CO", name: "Elbert County - Elizabeth Safeway - CO1080 192", address: "220 South Elizabeth Street Elizabeth, CO 80107", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1082": { code: "CO1082", state: "CO", name: "Alamosa County City Market CO1082 195", address: "131 Market St, Alamosa, CO 81101", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1084": { code: "CO1084", state: "CO", name: "Eagle County Beaver Creek City Market #426 CO1084 197", address: "72 Beaver Creek Place, Avon, CO 81620", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1086": { code: "CO1086", state: "CO", name: "Denver County Southwest DMV CO1086 199", address: "3100 South Sheridan Boulevard, A1, Denver, CO 80227", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "BK", remote: false, updatedAt: now },
    "CO1087": { code: "CO1087", state: "CO", name: "Denver County Northeast DMV CO1087 203", address: "4685 Peoria St. #101, Denver, CO 80239", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "BK", remote: false, updatedAt: now },
    "CO1088": { code: "CO1088", state: "CO", name: "Jefferson County - Golden King Soopers CO1088 204", address: "17171 South Golden Road, Golden, CO 80401", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now },
    "CO1089": { code: "CO1089", state: "CO", name: "Jefferson County Westgate Driver License Office", address: "3265 S. Wadsworth Blvd, Suite 3A, Lakewood, CO 80227", primaryTech: "", fallbackTech: "", defaultTech: "", contractorOverride: false, contractorName: "", machineType: "SK", remote: false, updatedAt: now }
  };

  const techs = {
    "luis-duran": { name: "Luis Duran", state: "CO", phone: "(813) 370-6455", email: "", homeAddress: "6157 Alpine Ridge Rd, Colorado Springs, CO 80925", smsAddress: "", active: true, updatedAt: now },
    "alejandro-abreu": { name: "Alejandro Abreu", state: "CO", phone: "(720) 612-3832", email: "", homeAddress: "2027 Grays Peak Dr, Unit 103, Loveland, CO 80538", smsAddress: "", active: true, updatedAt: now },
    "daren-dozier": { name: "Daren Dozier", state: "CO", phone: "(720) 690-5196", email: "", homeAddress: "10555 W Jewell Ave, Apt 4101, Lakewood, CO 80232", smsAddress: "", active: true, updatedAt: now },
    "joseph-osborn": { name: "Joseph Osborn", state: "CO", phone: "", email: "", homeAddress: "2827 Pitchblend Ct, Grand Junction, CO 81503", smsAddress: "", active: true, updatedAt: now },
    "dr.-joel": { name: "Dr. Joel", state: "CO", phone: "(970) 749-9465", email: "", homeAddress: "3221 W 6th Ave, Durango, CO 81301", smsAddress: "", active: true, updatedAt: now }
  };

  try {
    const store = getStore("dispatch");

    const existingLocs = (await store.get("locations/CO", { type: "json" })) || {};
    const mergedLocs = { ...existingLocs, ...locations };
    await store.setJSON("locations/CO", mergedLocs);

    const existingTechs = (await store.get("technicians/CO", { type: "json" })) || {};
    const mergedTechs = { ...existingTechs, ...techs };
    await store.setJSON("technicians/CO", mergedTechs);

    return json(200, {
      ok: true,
      locationsWritten: Object.keys(locations).length,
      techniciansWritten: Object.keys(techs).length,
      message: "Done. Check the admin panel's Locations and Technicians tabs for CO. You can delete this function file now.",
    });
  } catch (err) {
    return json(500, { error: "Backfill failed: " + err.message });
  }
};
