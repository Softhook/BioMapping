// Bio Mapping 2: a printed back for the M5Stack Cardputer ADV. It replaces
// M5Stack's back and holds the Cardputer's battery, as before, and our GSR +
// GPS board under it. See README.md in this folder.
//
// Make the STL files with `./pcb case` (in hardware/): it writes board.scad
// from the circuit board, builds the STLs and checks the fit. Or open this
// file in OpenSCAD, change a choice below, render (F6) and export.
//
// Print it floor down, open side up, in PETG or ASA. No supports needed. Then
// push a 2 mm drill through the thin cover at the top of each long screw's
// head hole.
//
// The top 6.5 mm (the rim and battery layer) copies M5Stack's own back, as
// measured from M5Stack's 3D model of the Cardputer ADV (MIT licence,
// github.com/m5stack/M5_Hardware, Products/K132-Adv_Cardputer-Adv): the
// outline, the wall faces, the two screw posts, and the EXT and headphone
// openings (the wrist-strap corner is closed off as a plain rounded corner).
// Its walls are nowhere thicker than M5Stack's, so nothing inside the
// Cardputer can touch them.
//
// Coordinates are the circuit board's (KiCad's): x along the Cardputer, y
// from the EXT edge, seen from the Cardputer's side, in mm; z up from the
// outside of the floor. The last step mirrors y, so the part comes out the
// right way round.

include <board.scad>

/* [Choices] */
// Air between the GPS module's top and the floor. u-blox asks for 5 mm; Test 2 (README) checks whether less costs signal
gps_gap = 3.0;
// Floor thickness
floor_t = 2.0;
// Air between the board's edge and the wall, all round: room for the board's cutting tolerance and a print that comes out a little small
board_gap = 0.5;
// Shelf round the inside of the wall that the board's edge rests on, measured from the wall: the board sits on this less board_gap
ledge = 1.2;
// Length of the two long M2 screws into the Cardputer
screw_len = 16;
// How far they go into the Cardputer's inserts: M5Stack's own screw length less 6 (README, measurement 1)
screw_engage = 3;
// true: holes for M2 heat-set inserts in the two board posts; false: the M2 screws cut their own thread
board_screw_inserts = true;
// A finger scoop in the end wall round the cuff window, so the cuff plug can be gripped
cuff_scoop = true;
// Text debossed into the outside of the floor (empty for a plain back)
back_text = "Bio Mapping 2";
// Mark the GPS antenna's position on the outside of the floor with a shallow rounded outline
gps_mark = true;
// Thin the floor over the GPS with a pocket cut into its inside face: less plastic over the antenna, and more air
gps_pocket = true;
// Floor left under that pocket
gps_floor = 1.2;
// What to make: back, rim_test (the battery layer on a 1 mm plate, to try the fit), assembly (a picture), fit_check
part = "back"; // [back, rim_test, assembly, fit_check]

/* [Hidden] */
$fa = 3; $fs = 0.2;
eps = 0.01;

// ── M5Stack's back (measured from M5Stack's model) ──
L = 84; W = 54;                    // outline at the rim
r_ext = 7.7; r_kbd = 3.0;          // its corners: on the EXT edge, on the keyboard edge
draft = 0.035;                     // the outside leans in this much per mm ...
draft_d = 4.5;                     // ... for this far below the rim, then runs straight down
bot_r = 1.0; bot_r_kbd = 3.0;      // the floor's rounded edge: 1 mm, and 3 mm along the keyboard edge
batt_d = 6.5;                      // rim to the inner face of M5Stack's floor: the battery's room
// the battery layer's inner wall faces [x0, y0, x1, y1] and corners. M5Stack's walls
// are 1.5 mm at the ends and on the keyboard edge, 1.9 mm on the EXT edge; at the EXT
// edge's corners its Lego tubes make them thicker. In the bottom 1.5 mm, beside its
// Lego tubes, its EXT wall is only 1.2 mm: ours follows it there
batt_in = [1.5, 1.75, 82.5, 52.5];
batt_r_ext = 6.2; batt_r_kbd = 1.5;
batt_in_low = [1.2, 1.5];          // EXT wall's inner face (y), and how far up from the battery layer's bottom
post_d = 4.0;                      // its two screw posts (with 2.2 mm holes; ours are screw_hole)
ext_open = [32.7, 51.3, 5.1];      // the EXT socket's opening: x from, x to, depth below the rim
phone_slot = [7.75, 13.25, 5.0];   // the headphone socket's slot: y from, y to, depth (round bottom)

// ── our parts ──
ledge_post_d = 7;                  // the long screw posts under the board: the ledge it rests on
head_d = 4.4;                      // room for an M2 screw head (cap head 3.8, pan head 4.0)
screw_hole = 2.4;                  // their holes: a printed 2.2 mm hole comes out about 2.0, and the screw would thread into it
cover = 0.3;                       // a thin cover over each head hole, so the hole above it never prints in mid-air: at least one layer
board_post_d = 6;                  // posts under the board's two M2 screws
pilot_d = 1.7; pilot_depth = 6;    // for an M2 screw to cut its own thread
insert_d = 3.2; insert_depth = 4;  // or for an M2 heat-set insert (3.2 mm hole, up to 4 mm long)
cuff_h = 6.0;                      // window in the end wall for the cuff plug, below the board:
cuff_w = cuff_socket[2] + 0.6;     // as wide as the socket, and this tall ...
cuff_up = 0.5;                     // ... plus this much above the board's face, so a sagging top can't rub the plug
scoop_w = 18; scoop_d = 1.8;       // the finger scoop round it: width along the wall, and depth
text_size = 3.8; text_depth = 0.4; // back lettering: 2 layers deep on a 0.2 mm print (1.6 mm floor remains)
text_x = 60.0;                     // centred between the cuff socket end (~78) and the GPS outline (38.75)
text_y = gps[1];                   // in line with the centre of the GPS rectangle
text_font = "Helvetica Neue:style=Bold";
gps_box = [16.5, 16.5, 2.5, 0.8];  // outline over the 15.5 mm GPS module: width, height, corner radius, line width
gps_mark_depth = 0.2;              // one layer on a 0.2 mm print
gps_pocket_size = [18.5, 18.5, 3]; // pocket on the inside: width, height, corner radius (covers the outline with 1 mm to spare)
min_floor = 1.0;                   // thinnest plastic allowed anywhere over the GPS

// ── the stack, from the floor up ──
part_h = max([for (p = parts_B) p[4]]);        // the tallest part on the board's outer face: the GPS
z_board_B = floor_t + part_h + gps_gap;          // the board's outer face
z_board_F = z_board_B + board_t;                 // its inner face, where M5Stack's floor was
H = z_board_F + batt_d;                          // the rim
z_seat = H - (screw_len - screw_engage);         // where the long screws' heads sit

assert(z_seat > 1, str("the long screws are too short: ", screw_len, " mm reaches only ", screw_len - screw_engage,
                         " of the ", H, " mm to the rim"));
gps_floor_min = (gps_pocket ? gps_floor : floor_t) - (gps_mark ? gps_mark_depth : 0);
assert(gps_floor_min >= min_floor, str("the floor over the GPS would be only ", gps_floor_min, " mm thick (at least ",
                                       min_floor, " mm)"));
assert(!gps_pocket || gps_floor <= floor_t, "gps_floor must not be thicker than floor_t");
assert(z_seat < z_board_B - 2, "the long screws are too long: their heads would sit above the board's ledge");

// ── shapes ──

// a rounded rectangle; rt: radius of the corners on the EXT edge (y0), rb: on the keyboard edge (y1)
module rrect(x0, y0, x1, y1, rt, rb) {
    hull() {
        for (x = [x0 + rt, x1 - rt]) translate([x, y0 + rt]) circle(max(rt, eps));
        for (x = [x0 + rb, x1 - rb]) translate([x, y1 - rb]) circle(max(rb, eps));
    }
}

// how far the outside steps in at height z: the draft near the rim ...
function draft_in(z) = draft * min(max(H - z, 0), draft_d);
// ... and the floor's rounded edge, which turns into a 45 degree chamfer at the print
// bed, so the first layers never overhang
function edge_in(z, R) = z >= R ? 0
    : z >= R * (1 - sin(45)) ? R - sqrt(R * R - (R - z) * (R - z))
    : R * (1 - cos(45)) + R * (1 - sin(45)) - z;

module slab(z) {
    s = draft_in(z); e = edge_in(z, bot_r); k = edge_in(z, bot_r_kbd);
    translate([0, 0, z]) linear_extrude(eps)
        rrect(s + e, s + e, L - s - e, W - s - k, r_ext - s - e, r_kbd - s - max(e, k));
}

module outside() {
    hull() {
        for (z = [0 : 0.2 : bot_r_kbd]) slab(z);
        slab(H - draft_d); slab(H - eps);
    }
}

module board_shape() polygon(board_outline);

module hollow() {
    // battery layer: M5Stack's walls
    translate([0, 0, z_board_F]) linear_extrude(H - z_board_F + 1)
        rrect(batt_in[0], batt_in[1], batt_in[2], batt_in[3], batt_r_ext, batt_r_kbd);
    // the thinner bottom band of the EXT wall, then a 45 degree slope up to the full wall, so it
    // never overhangs. Along the slope our wall is still thinner than M5Stack's
    translate([0, 0, z_board_F]) hull() {
        linear_extrude(batt_in_low[1])
            rrect(batt_in[0], batt_in_low[0], batt_in[2], batt_in[3], batt_r_ext, batt_r_kbd);
        translate([0, 0, batt_in_low[1] + batt_in[1] - batt_in_low[0]]) linear_extrude(eps)
            rrect(batt_in[0], batt_in[1], batt_in[2], batt_in[3], batt_r_ext, batt_r_kbd);
    }
    // the board's own layer: its edge plus the gap
    translate([0, 0, z_board_B]) linear_extrude(board_t + eps) offset(delta = board_gap) board_shape();
    // under the board: the ledge it rests on all round
    translate([0, 0, floor_t]) linear_extrude(z_board_B - floor_t + eps) offset(delta = board_gap - ledge) board_shape();
}

module posts() {
    for (p = long_posts) translate([p[0], p[1], 0]) {
        cylinder(d = ledge_post_d, h = z_board_B);
        cylinder(d = post_d, h = H);
    }
    for (p = board_screws) translate([p[0], p[1], 0]) cylinder(d = board_post_d, h = z_board_B);
}

module holes() {
    for (p = long_posts) translate([p[0], p[1], 0]) {
        translate([0, 0, z_seat + cover]) cylinder(d = screw_hole, h = H);
        translate([0, 0, -1]) cylinder(d = head_d, h = z_seat + 1);
    }
    for (p = board_screws) translate([p[0], p[1], 0])
        if (board_screw_inserts)
            translate([0, 0, z_board_B - insert_depth]) cylinder(d = insert_d, h = insert_depth + 1);
        else
            translate([0, 0, z_board_B - pilot_depth]) cylinder(d = pilot_d, h = pilot_depth + 1);
    // the EXT socket's opening, as in M5Stack's back (the socket's body fills it)
    translate([ext_open[0], -1, H - ext_open[2]]) cube([ext_open[1] - ext_open[0], batt_in[1] + 1.5, ext_open[2] + 1]);
    // the headphone socket's slot, open at the rim, round at the bottom
    hull() for (z = [H - phone_slot[2] + (phone_slot[1] - phone_slot[0]) / 2, H + 3])
        translate([batt_in[2] - 0.5, (phone_slot[0] + phone_slot[1]) / 2, z]) rotate([0, 90, 0])
            cylinder(d = phone_slot[1] - phone_slot[0], h = L - batt_in[2] + 2);
    // window for the cuff plug, under the board
    translate([cuff_socket[0] - 2, cuff_socket[1] - cuff_w / 2, z_board_B - cuff_h])
        cube([L - cuff_socket[0] + 4, cuff_w, cuff_h + cuff_up]);
    if (cuff_scoop) scoop();
    // debossed lettering and GPS antenna outline on the outside of the floor. The text is rotated
    // 180 degrees here so that after the final mirror([0, 1, 0]) it reads left-to-right,
    // right-side-up when viewing the back of the Cardputer with the EXT / screen edge at the top
    if (back_text != "")
        translate([text_x, text_y, -eps]) rotate([0, 0, 180]) linear_extrude(text_depth + eps)
            text(back_text, size = text_size, font = text_font, halign = "center", valign = "center", $fn = 24);
    if (gps_mark)
        translate([gps[0], gps[1], -eps]) linear_extrude(gps_mark_depth + eps) difference() {
            rrect(-gps_box[0] / 2, -gps_box[1] / 2, gps_box[0] / 2, gps_box[1] / 2, gps_box[2], gps_box[2]);
            offset(delta = -gps_box[3])
                rrect(-gps_box[0] / 2, -gps_box[1] / 2, gps_box[0] / 2, gps_box[1] / 2, gps_box[2], gps_box[2]);
        }
    // the pocket over the GPS, cut into the floor's inside face. Kept inside the shelf the board
    // rests on, so it never weakens the shelf. Prints with no overhang: its floor is built first
    if (gps_pocket)
        translate([0, 0, gps_floor]) linear_extrude(floor_t - gps_floor + eps) intersection() {
            translate(gps) rrect(-gps_pocket_size[0] / 2, -gps_pocket_size[1] / 2, gps_pocket_size[0] / 2,
                                 gps_pocket_size[1] / 2, gps_pocket_size[2], gps_pocket_size[2]);
            offset(delta = board_gap - ledge) board_shape();
        }
}

// A shallow dip in the end wall round the cuff window, so a finger and thumb reach the sides of
// the plug: part of a big upright cylinder, scoop_w wide where it meets the wall and scoop_d
// deep. Starts level with the window floor (keeping full wall thickness below it) and slopes
// back at 45 degrees so it clears the bridge over the window before z_board_B + cuff_up
module scoop() {
    r = (pow(scoop_w / 2, 2) + pow(scoop_d, 2)) / (2 * scoop_d);
    z0 = z_board_B - cuff_h; z1 = z_board_B - 1.4;
    translate([L - scoop_d + r, cuff_socket[1], 0]) hull() {
        translate([0, 0, z0]) cylinder(r = r, h = z1 - z0);
        translate([scoop_d, 0, z1 + scoop_d]) cylinder(r = r, h = eps);
    }
}

module back_raw() {
    difference() {
        union() {
            difference() { outside(); hollow(); }
            posts();
        }
        holes();
    }
}

// ── the board, its parts and the plugs, for the fit check and the picture ──

// lifted 0.02 mm clear of the faces they are meant to touch (the ledge, the post tops, the
// cuff window's floor), so only a real overlap shows in the fit check
t = 0.02;
module board3d() translate([0, 0, z_board_B + t]) linear_extrude(board_t - 2 * t) difference() {
    board_shape();
    for (p = long_posts) translate(p) circle(d = post_holes);
    for (p = board_screws) translate(p) circle(d = board_screw_holes);
}
module parts3d() {
    for (p = parts_B) translate([p[0], p[1], z_board_B - p[4] + t]) cube([p[2] - p[0], p[3] - p[1], p[4] - 2 * t]);
    for (p = parts_F) translate([p[0], p[1], z_board_F + t]) cube([p[2] - p[0], p[3] - p[1], p[4]]);
}
module plugs3d() {
    // the cable's plug in J1 on the inner face, and its wires' first bend: 7 mm in front of the mouth
    translate([cable_socket[0] - 5.6, cable_socket[1], z_board_F + 0.4]) cube([11.2, 7, 3.6]);
    // the cuff plug in J2: 6 x 4.5 mm, out through the window and 5 mm beyond the case
    translate([cuff_socket[0] - 1, cuff_socket[1] - 3.3, z_board_B - 5.0]) cube([L - cuff_socket[0] + 6, 6.6, 4.8]);
    // the heads of the board's two screws, on the inner face
    for (p = board_screws) translate([p[0], p[1], z_board_F + t]) cylinder(d = 4.0, h = 1.6);
}
// the board on its way in: dropped in from above the rim
module board_path() translate([0, 0, z_board_B + t]) linear_extrude(H - z_board_B + 1) difference() {
    board_shape();
    for (p = long_posts) translate(p) circle(d = post_holes);
}

// The battery layer on a 1 mm plate, to try on the Cardputer in about an hour. The plate is
// where M5Stack's floor was (just under the battery layer), so nothing of the Cardputer can be
// there; it joins the walls and both screw posts into one piece. Printed plate down
module rim_test() {
    z0 = z_board_F - 1;
    translate([0, 0, -z0]) intersection() {
        union() {
            back_raw();
            difference() {
                intersection() { outside(); translate([-5, -5, z0]) cube([L + 10, W + 10, 1]); }
                for (p = long_posts) translate([p[0], p[1], z0 - 1]) cylinder(d = screw_hole, h = 3);
            }
        }
        translate([-5, -5, z0]) cube([L + 10, W + 10, H - z0 + 1]);
    }
}

// ── output ──
echo(str("rim to floor ", H, " mm (M5Stack's back: 8 mm); the Cardputer becomes ", round((19.6 - 8 + H) * 10) / 10,
         " mm thick (19.6 today). Long screws M2 x ", screw_len, ", heads ", z_seat, " mm up from the floor."));

mirror([0, 1, 0]) {
    if (part == "back") back_raw();
    if (part == "rim_test") rim_test();
    if (part == "fit_check")  // must come out empty
        intersection() {
            back_raw();
            union() { board3d(); parts3d(); plugs3d(); board_path(); }
        }
    if (part == "assembly") {   // cut open along y 30, to show the inside
        difference() {
            color("lightgrey") back_raw();
            translate([-5, 30, -1]) cube([L + 10, W, H + 5]);
        }
        color("seagreen") board3d();
        color("goldenrod") parts3d();
    }
}
