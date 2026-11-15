// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixed value pools the PRNG draws from. Every list is fixed text in a fixed order, so draws are repeatable.
// Names are common US given names and surnames; none is a real customer (the business and its people are fictional).

const words = (s: string): string[] => s.trim().split(/\s+/);

export const FIRST_NAMES = words(`
Aaron Abigail Adam Adrian Alan Albert Alex Alice Alicia Allison Amanda Amber Amy Andrea Andrew Angela Anita Ann Anna
Anthony April Arthur Ashley Audrey Austin Barbara Benjamin Beth Betty Beverly Bill Billy Bobby Bonnie Brad Brandon
Brenda Brett Brian Brittany Bruce Bryan Caleb Calvin Cameron Carl Carla Carol Caroline Carrie Catherine Chad Charles
Charlotte Cheryl Christina Christine Christopher Cindy Claire Clara Clifford Colin Connie Courtney Craig Crystal Curtis
Cynthia Dale Dana Daniel Danielle Darlene Darren David Dawn Dean Debra Denise Dennis Derek Diana Diane Donald Donna
Doris Dorothy Douglas Dustin Dylan Earl Edith Edward Eileen Elaine Eleanor Elizabeth Ellen Emily Emma Eric Erica Ethan
Eugene Evan Evelyn Frances Frank Fred Gail Gary Gene George Gerald Gina Glen Gloria Gordon Grace Gregory Hannah Harry
Heather Helen Henry Holly Howard Ian Isaac Jack Jacob Jacqueline James Jamie Janet Janice Jared Jason Jean Jeffrey
Jennifer Jeremy Jerry Jesse Jessica Jill Joan Joanne Joel John Jonathan Jordan Joseph Joshua Joyce Judith Judy Julia
Julie Justin Karen Katherine Kathryn Keith Kelly Kenneth Kerry Kimberly Kristen Kyle Larry Laura Lauren Lawrence Leah
Lee Leonard Leslie Lillian Lindsay Lisa Logan Lois Lori Louis Lucas Lynn Madison Marcia Margaret Marie Marilyn Mark
Martha Martin Mary Matthew Megan Melanie Melissa Michael Michelle Mildred Mitchell Monica Nancy Natalie Nathan Neil
Nicholas Nicole Noah Norma Norman Olivia Pamela Patricia Patrick Paula Peggy Peter Philip Phyllis Rachel Ralph Randall
Randy Raymond Rebecca Regina Renee Rhonda Richard Robert Robin Rodney Roger Ronald Rose Roy Russell Ruth Ryan Samantha
Samuel Sandra Sara Scott Shannon Sharon Shawn Sheila Shirley Stacy Stanley Stephanie Stephen Steven Susan Tammy Tanya
Teresa Terry Theodore Theresa Thomas Tiffany Timothy Todd Tracy Travis Tyler Valerie Vanessa Victor Victoria Vincent
Virginia Walter Wanda Warren Wayne Wendy William Zachary
`);

export const HISPANIC_FIRST_NAMES = words(`
Adriana Alejandro Ana Andres Antonio Beatriz Carlos Carmen Cristina Diego Eduardo Elena Enrique Esperanza Fernando
Gabriela Guadalupe Hector Ignacio Isabel Javier Jorge Juan Leticia Lorena Luis Lucia Manuel Marisol Miguel Monserrat
Pablo Raul Ricardo Rosario Santiago Silvia Sofia Veronica Ximena Yolanda
`);

export const HISPANIC_SURNAMES = words(`
Acosta Aguilar Alvarado Alvarez Avila Barrera Cabrera Calderon Campos Castillo Castro Cervantes Chavez Contreras
Cortez Cruz Dominguez Escobar Espinoza Estrada Fernandez Figueroa Flores Fuentes Garcia Gomez Gonzalez Guerrero
Gutierrez Guzman Hernandez Herrera Ibarra Jimenez Juarez Lopez Lozano Luna Maldonado Marquez Martinez Medina Mejia
Mendez Mendoza Miranda Molina Morales Moreno Munoz Navarro Nunez Ochoa Orozco Ortiz Pacheco Padilla Pena Perez Ramirez
Ramos Reyes Rios Rivera Rodriguez Rojas Romero Rosales Rubio Salazar Salinas Sanchez Sandoval Santiago Serrano Silva
Soto Suarez Torres Trujillo Valdez Valencia Vargas Vasquez Vega Velasquez Zamora
`);

export const SURNAMES = words(`
Abbott Adams Adkins Albright Aldridge Allen Allison Anderson Andrews Armstrong Arnold Atkins Atkinson Austin Bailey
Baker Baldwin Ball Ballard Banks Barber Barker Barlow Barnes Barnett Barr Barrett Barton Bates Bauer Baxter Beard
Beck Becker Bell Bennett Benson Berg Berry Bishop Black Blackburn Blair Blake Blankenship Bolton Bond Boone Bowen
Bowers Bowman Boyd Boyer Bradford Bradley Brady Brandt Brennan Brewer Bridges Briggs Brock Brooks Brown Bryan Bryant
Buchanan Buckley Burch Burgess Burke Burnett Burns Burton Bush Butler Byrd Caldwell Callahan Cameron Campbell Cannon
Carey Carlson Carpenter Carr Carroll Carson Carter Carver Case Casey Chambers Chandler Chapman Christensen Clark Clarke
Clay Clayton Cline Cobb Cochran Coffey Cole Coleman Collier Collins Combs Compton Conley Conner Conrad Conway Cook
Cooley Cooper Copeland Cox Craft Craig Crane Crawford Crosby Cross Cummings Cunningham Curry Curtis Dalton Daniel
Daniels Daugherty Davidson Davis Dawson Day Dean Decker Delaney Dennis Dickerson Dickson Dillon Dixon Dodson Donovan
Dorsey Dougherty Douglas Downey Doyle Drake Dudley Duffy Duke Duncan Dunlap Dunn Durham Dyer Eaton Edwards Elliott
Ellis Ellison Emerson England English Erickson Evans Everett Farmer Farrell Faulkner Ferguson Fields Finch Finley
Fischer Fisher Fitzgerald Fleming Fletcher Flynn Foley Forbes Ford Foster Fowler Fox Francis Franklin Frazier
Frederick Freeman French Frost Fry Fuller Gaines Gallagher Gamble Gardner Garner Garrett Garrison Gates Gentry Gibbs
Gibson Gilbert Giles Gill Gillespie Glass Glenn Goodman Goodwin Gordon Graham Grant Graves Gray Green Greene Greer
Gregory Griffin Griffith Grimes Gross Hahn Hale Hall Hamilton Hammond Hampton Hancock Hansen Hanson Hardin Harding
Hardy Harmon Harper Harrington Harris Harrison Hart Hartman Harvey Hatfield Hawkins Hayes Haynes Heath Henderson
Hendricks Henry Hensley Herman Hess Hester Hickman Hicks Higgins Hill Hines Hinton Hobbs Hodge Hodges Hoffman Hogan
Holden Holland Holloway Holmes Holt Hood Hooper Hoover Hopkins Horn Horton House Houston Howard Howe Howell Hubbard
Huber Hudson Huff Hughes Hull Humphrey Hunt Hunter Hurley Hutchinson Ingram Irwin Jackson Jacobs Jarvis Jefferson
Jenkins Jennings Jensen Johns Johnson Johnston Jones Jordan Joyce Kane Kaufman Keller Kelley Kelly Kemp Kendall
Kennedy Kent Kerr Key Kidd Kimball King Kinney Kirby Kirk Klein Knapp Knight Knox Koch Kramer Krause Kruger Lambert
Lamb Lane Lang Lara Larsen Larson Lawrence Lawson Leach Leblanc Lee Leonard Lester Levine Lewis Lindsey Little
Livingston Lloyd Logan Long Lowe Lowery Lucas Lynch Lyons Mack Madden Maddox Mahoney Malone Mann Manning Marsh
Marshall Martin Mason Massey Mathews Matthews Maxwell May Maynard McBride McCarthy McClain McConnell McCormick McCoy
McCullough McDaniel McDonald McDowell McGee McGuire McIntosh McKay McKenzie McKinney McLaughlin McMahon McNeil
Meadows Melton Mercer Merrill Meyer Meyers Middleton Miles Miller Mills Mitchell Monroe Montgomery Moody Moon Moore
Morgan Morris Morrison Morrow Morton Moses Mosley Moss Mueller Mullins Murphy Murray Myers Nash Neal Nelson Newman
Newton Nichols Nicholson Nixon Noble Nolan Norman Norris Norton Oconnor Odom Oliver Olsen Olson Oneal Oneill Osborne
Owen Owens Page Palmer Parker Parks Parrish Parsons Patel Patrick Patterson Patton Paul Payne Pearson Peck Pennington
Perkins Perry Peters Petersen Peterson Phelps Phillips Pierce Pittman Pollard Poole Pope Porter Potter Powell Powers
Pratt Preston Price Prince Pruitt Pugh Quinn Ramsey Randall Randolph Rasmussen Ray Raymond Reed Reese Reid Reilly
Rhodes Rice Rich Richards Richardson Richmond Riddle Riggs Riley Ritter Roach Robbins Roberson Roberts Robertson
Robinson Rodgers Rogers Rollins Rose Ross Roth Rowe Rowland Russell Ryan Sampson Sanders Sargent Saunders Savage
Sawyer Schmidt Schneider Schroeder Schultz Schwartz Scott Sellers Shaffer Shannon Sharp Shaw Shelton Shepherd Sherman
Shields Short Simmons Simon Simpson Sims Singleton Skinner Slater Sloan Small Smith Snow Snyder Sparks Spears Spencer
Stafford Stanley Stark Steele Stein Stephens Stephenson Stevens Stevenson Stewart Stokes Stone Stout Strickland Strong
Stuart Sullivan Summers Sutton Swanson Sweeney Tanner Tate Taylor Terrell Terry Thomas Thompson Thornton Todd Townsend
Tucker Turner Tyler Underwood Vance Vaughn Wade Wagner Walker Wall Wallace Waller Walsh Walter Walters Walton Ward
Ware Warner Warren Waters Watkins Watson Watts Weaver Webb Weber Webster Weeks Welch Wells West Wheeler Whitaker White
Whitehead Whitney Wiggins Wilcox Wiley Wilkerson Wilkins Wilkinson Williams Williamson Willis Wilson Winters Wise
Witt Wolf Wolfe Wong Wood Woodard Woods Woodward Wright Wyatt Yates York Young Zimmerman Ackerman Bachman Bauman
Brenner Dietrich Eckert Fenner Gerber Haas Hartley Hirsch Holtz Kessler Koenig Kuhn Lehman Lutz Metzger Nagel Ostrander
Pfeiffer Reinhardt Richter Sauer Schaeffer Schott Seiler Strauss Ulrich Vogel Wagoner Weiss Ziegler Kowalczyk Nowak
Wozniak Lewandowski Zielinski Szymanski Kaminski Novak Horvath Varga Petrovic Kovacs Rossi Russo Romano Bianchi
Colombo Ricci Marino Greco Bruno Gallo Conti DeLuca Costa Giordano Mancini Lombardi Moretti Barbieri Fontana Santoro
Mariani Rinaldi Caruso Ferrara Galli Martini Leone Longo Gentile Martinelli Vitale Serra Coppola DeSantis Fabbri
Nguyen Tran Pham Le Hoang Huynh Vo Dang Bui Do Ngo Duong Ly Chen Wang Li Zhang Liu Yang Huang Zhao Wu Zhou Xu Sun Ma
Zhu Hu Guo Lin Kim Park Choi Jung Kang Cho Yoon Jang Lim Han Shin Seo Kwon Hwang Ahn Song Yoo Hong Jeon Ko Moon Yang
Shah Desai Mehta Joshi Kumar Singh Sharma Gupta Reddy Rao Iyer Nair Menon Pillai Chopra Kapoor Malhotra Bhatt Agarwal
Okafor Adeyemi Okonkwo Mensah Owusu Boateng Asante Diallo Toure Keita Abebe Tesfaye Haile Bekele Mwangi Otieno
Kamau Ochieng Achieng Wanjiru Farah Hassan Ali Ahmed Mohamed Ibrahim Yusuf Haddad Khoury Nasser Saleh Mansour Aziz
Lindqvist Johansson Andersson Karlsson Nilsson Eriksson Larsson Olofsson Persson Svensson Gustafsson Pettersson
Jonsson Berglund Lundgren Lindberg Sandberg Nordstrom Holmberg Lindgren Ostberg Dahl Hagen Bakke Strand Moen Haugen
Rasch Brandvold Sorensen Kristensen Madsen Mortensen Poulsen Thomsen Lund Vestergaard Jakobsen Christiansen Iversen
Murtagh Brennan Gallagher Doherty Kavanagh Byrne Kearney Keane Lynch Moran Nolan Quigley Regan Sheehan Tierney
Whelan Cullen Fennelly Hennessy Mulligan Rafferty Toomey Costello Dempsey Flanagan Geraghty Hegarty Lennon Maguire
`);

/** Given name to a common short form, for likely-duplicate pairs planted by nickname. */
export const NICKNAMES: Readonly<Record<string, string>> = {
  Katherine: 'Kathy', Robert: 'Bob', William: 'Bill', Elizabeth: 'Liz', James: 'Jim', Michael: 'Mike',
  Richard: 'Rick', Thomas: 'Tom', Joseph: 'Joe', Daniel: 'Dan', Christopher: 'Chris', Margaret: 'Maggie',
  Patricia: 'Pat', Jennifer: 'Jenny', Susan: 'Sue', Rebecca: 'Becky', Anthony: 'Tony', Steven: 'Steve',
  Edward: 'Ed', Kenneth: 'Ken', Ronald: 'Ron', Timothy: 'Tim', Jeffrey: 'Jeff', Gregory: 'Greg', Matthew: 'Matt',
  Andrew: 'Andy', Joshua: 'Josh', Nicholas: 'Nick', Benjamin: 'Ben', Samuel: 'Sam', Jonathan: 'Jon',
  Douglas: 'Doug', Raymond: 'Ray', Lawrence: 'Larry', Gerald: 'Jerry', Donald: 'Don', Charles: 'Charlie',
  Barbara: 'Barb', Kimberly: 'Kim', Cynthia: 'Cindy', Pamela: 'Pam', Victoria: 'Vicky', Theresa: 'Terri',
  Catherine: 'Cathy', Kathryn: 'Kate', Judith: 'Judy', Deborah: 'Debbie', Frederick: 'Fred', Stephanie: 'Steph',
  Alexander: 'Alex', Zachary: 'Zach', Theodore: 'Ted', Leonard: 'Len', Walter: 'Walt', Philip: 'Phil',
  Gregorio: 'Goyo', Francisco: 'Paco', Eduardo: 'Lalo', Guadalupe: 'Lupe', Ignacio: 'Nacho', Enrique: 'Kike',
};

/** The fixed home-type list in words (SD-24); an empty cell means the old system had none. */
export const HOME_TYPES = [
  'Single family, basement',
  'Single family, crawl space',
  'Single family, slab',
  'Townhouse',
  'Condo',
  'Duplex',
  'Mobile home',
] as const;

export const GETTING_IN = [
  'Side door. Knock firmly.',
  'Gate code at the side fence; dog in the yard.',
  'Use the back door off the driveway.',
  'Ring twice; hard of hearing.',
  'Park on the street, not the driveway.',
  'Key in the lockbox; the office has the code.',
];

/** The seeded services of SPECIFICATIONS SD-20, by the id the fixture names them with (README "Service ids"). */
export const SERVICES = [
  { id: 'furnace_tune_up', label: 'Furnace tune-up', minutes: 60, skill: 'hvac' },
  { id: 'ac_tune_up', label: 'AC tune-up', minutes: 60, skill: 'hvac' },
  { id: 'heating_or_ac_fix', label: 'Heating or AC fix', minutes: 90, skill: 'hvac' },
  { id: 'plumbing_repair', label: 'Plumbing repair', minutes: 90, skill: 'plumbing' },
  { id: 'water_heater', label: 'Water heater', minutes: 120, skill: 'plumbing' },
  { id: 'thermostat', label: 'Thermostat', minutes: 60, skill: 'hvac' },
  { id: 'boiler_repair', label: 'Boiler repair', minutes: 120, skill: 'hvac' },
  { id: 'tankless_heater_flush', label: 'Tankless heater flush', minutes: 60, skill: 'plumbing' },
  { id: 'sump_pump_install', label: 'Sump pump install', minutes: 180, skill: 'install' },
] as const;

export type ServiceId = (typeof SERVICES)[number]['id'];

/** Old-system service texts and what was done (visits.csv `service`, `work_done`). Weighted by repetition. */
export const OLD_SERVICES: readonly { service: string; done: readonly string[] }[] = [
  { service: 'Furnace tune-up', done: ['Cleaned the flame sensor, replaced the filter.', 'All readings normal.', 'Replaced the filter. Checked the heat exchanger.'] },
  { service: 'Furnace tune-up', done: ['Cleaned the burners.', 'All readings normal.'] },
  { service: 'AC tune-up', done: ['Cleaned the outdoor coil.', 'Cleaned the outdoor coil. Capacitor a little low.', 'Checked refrigerant; normal.'] },
  { service: 'AC tune-up', done: ['Replaced the condensate line.', 'All readings normal.'] },
  { service: 'No heat (repair)', done: ['Replaced the igniter.', 'Replaced the pressure switch.', 'Reset the limit switch; cleaned the sensor.'] },
  { service: 'AC not cooling', done: ['Replaced the contactor.', 'Replaced the run capacitor.', 'Cleared the condensate drain.'] },
  { service: 'Water heater flush', done: ['Flushed sediment; anode rod fine.', 'Flushed sediment.'] },
  { service: 'Water heater repair', done: ['Replaced the thermocouple.', 'Replaced the gas valve.'] },
  { service: 'Plumbing repair', done: ['Replaced the shutoff valve.', 'Cleared the drain line.', 'Fixed a leak under the sink.'] },
  { service: 'Thermostat install', done: ['Installed and set up a programmable thermostat.'] },
  { service: 'Boiler repair', done: ['Bled the radiators; replaced the circulator pump.'] },
  { service: 'Sump pump install', done: ['Installed a new sump pump with a check valve.'] },
];

export const EQUIPMENT_TYPES = [
  { type: 'furnace', weight: 26, label: ['Gas furnace', 'Electric furnace'], location: ['basement', 'utility closet', 'attic', 'crawl space'] },
  { type: 'air_conditioner', weight: 24, label: ['Central air conditioner'], location: ['outdoor unit at the back', 'outdoor unit on the side', 'outdoor unit on the east side'] },
  { type: 'water_heater', weight: 20, label: ['Gas water heater', 'Electric water heater', 'Tankless water heater'], location: ['basement', 'garage', 'utility closet'] },
  { type: 'thermostat', weight: 16, label: ['Programmable thermostat', 'Smart thermostat'], location: ['hallway, first floor', 'living room', 'upstairs hallway'] },
  { type: 'heat_pump', weight: 7, label: ['Heat pump'], location: ['outdoor unit at the back', 'outdoor unit on the side'] },
  { type: 'sump_pump', weight: 5, label: ['Sump pump'], location: ['basement'] },
  { type: 'boiler', weight: 2, label: ['Gas boiler'], location: ['basement'] },
] as const;

export const FORMER_TECHNICIANS = ['Gary Lindqvist', 'Phil Mertz', 'Wendy Tran', 'Rick Albers', 'Joe Pacheco', 'Dale Huffman'];

export const NOT_RECORDED = 'Not recorded';

export const EMAIL_DOMAIN = 'example.com';
