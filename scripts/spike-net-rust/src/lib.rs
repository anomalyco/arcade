#![no_std]
#![allow(dead_code)]

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

const MAX_ZOMBIES: usize = 512;
const MAX_SURVIVORS: usize = 4;
const GRID_W: usize = 192;
const GRID_H: usize = 192;
const GRID_CELLS: usize = GRID_W * GRID_H;
const HISTORY_TICKS: usize = 32;

// Raw Zombie struct (36 bytes in memory, 15 bytes on wire in current Outbreak format)
#[repr(C)]
#[derive(Clone, Copy)]
pub struct RawZombie {
    pub id: u16,
    pub state: u8,
    pub hp: u8,
    pub seed: u32,
    pub x: f32,
    pub y: f32,
    pub vx: f32,
    pub vy: f32,
    pub aim: f32,
    pub hit_flash: f32,
    pub state_time: f32,
    pub timer: f32,
    pub clamber: f32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct QuantizedZombie {
    pub id: u16,
    pub qx: i16, // 2cm units relative to window origin
    pub qy: i16,
    pub qaim: u8,
    pub state_flags: u8,
    pub hp: u8,
    pub timers: u8,
}

static mut ZOMBIES: [RawZombie; MAX_ZOMBIES] = [RawZombie {
    id: 0,
    state: 0,
    hp: 100,
    seed: 7,
    x: 0.0,
    y: 0.0,
    vx: 0.0,
    vy: 0.0,
    aim: 0.0,
    hit_flash: 0.0,
    state_time: 0.0,
    timer: 0.0,
    clamber: 0.0,
}; MAX_ZOMBIES];

static mut DECODED_ZOMBIES: [RawZombie; MAX_ZOMBIES] = [RawZombie {
    id: 0,
    state: 0,
    hp: 100,
    seed: 7,
    x: 0.0,
    y: 0.0,
    vx: 0.0,
    vy: 0.0,
    aim: 0.0,
    hit_flash: 0.0,
    state_time: 0.0,
    timer: 0.0,
    clamber: 0.0,
}; MAX_ZOMBIES];

// 32-tick history ring buffer of quantized zombies for delta encoding AND server hitscan lag-compensation rewind
static mut HISTORY: [[QuantizedZombie; MAX_ZOMBIES]; HISTORY_TICKS] = [[QuantizedZombie {
    id: 0,
    qx: 0,
    qy: 0,
    qaim: 0,
    state_flags: 0,
    hp: 0,
    timers: 0,
}; MAX_ZOMBIES]; HISTORY_TICKS];

static mut SURVIVOR_POS: [(f32, f32); MAX_SURVIVORS] = [(27.7, 41.0), (29.3, 41.2), (26.1, 41.2), (27.7, 42.6)];
static mut FLOW_COST: [u16; GRID_CELLS] = [0xffff; GRID_CELLS];
static mut NAV_GRID: [u8; GRID_CELLS] = [0; GRID_CELLS];

// Spatial hash for O(1) zombie-zombie separation (64x64 cells of 1.5m)
const HASH_W: usize = 64;
const HASH_CELLS: usize = HASH_W * HASH_W;
static mut CELL_HEAD: [i16; HASH_CELLS] = [-1; HASH_CELLS];
static mut AGENT_NEXT: [i16; MAX_ZOMBIES] = [-1; MAX_ZOMBIES];

static mut WIRE_OUT: [u8; 65536] = [0; 65536];
static mut INSTANCE_OUT: [f32; MAX_ZOMBIES * 8 * 12] = [0.0; MAX_ZOMBIES * 8 * 12];

// Fixed-point Q16.16 simulation arrays for deterministic lockstep/rollback comparison
static mut FP_X: [i32; MAX_ZOMBIES] = [0; MAX_ZOMBIES];
static mut FP_Y: [i32; MAX_ZOMBIES] = [0; MAX_ZOMBIES];
static mut FP_VX: [i32; MAX_ZOMBIES] = [0; MAX_ZOMBIES];
static mut FP_VY: [i32; MAX_ZOMBIES] = [0; MAX_ZOMBIES];
static mut FP_AIM: [u16; MAX_ZOMBIES] = [0; MAX_ZOMBIES];

#[inline(always)]
fn sqrt_f32(x: f32) -> f32 {
    use core::arch::wasm32::{f32x4_extract_lane, f32x4_splat, f32x4_sqrt};
    f32x4_extract_lane::<0>(f32x4_sqrt(f32x4_splat(x)))
}

#[inline(always)]
fn fast_sin(mut x: f32) -> f32 {
    const INV_TAU: f32 = 0.15915494;
    const TAU: f32 = 6.2831853;
    let k = (x * INV_TAU + if x >= 0.0 { 0.5 } else { -0.5 }) as i32;
    x -= (k as f32) * TAU;
    let y = x * (1.2732395 - 0.40528473 * if x < 0.0 { -x } else { x });
    0.225 * (y * if y < 0.0 { -y } else { y } - y) + y
}

#[inline(always)]
fn fast_cos(x: f32) -> f32 {
    fast_sin(x + 1.5707963)
}

#[inline(always)]
fn clamp_i16(v: i32) -> i16 {
    if v < -32768 {
        -32768
    } else if v > 32767 {
        32767
    } else {
        v as i16
    }
}

#[inline(always)]
fn clamp_u8(v: i32) -> u8 {
    if v < 0 {
        0
    } else if v > 255 {
        255
    } else {
        v as u8
    }
}

#[inline(always)]
fn pack_angle_u16(a: f32) -> u16 {
    let mut frac = a * 0.15915494;
    frac = frac - (frac as i32 as f32);
    if frac < 0.0 {
        frac += 1.0;
    }
    ((frac * 65536.0) as i32 & 0xffff) as u16
}

#[inline(always)]
fn unpack_angle_u16(v: u16) -> f32 {
    (v as f32) * (6.2831853 / 65536.0)
}

#[inline(always)]
fn pack_angle_u8(a: f32) -> u8 {
    let mut frac = a * 0.15915494;
    frac = frac - (frac as i32 as f32);
    if frac < 0.0 {
        frac += 1.0;
    }
    ((frac * 256.0) as i32 & 0xff) as u8
}

#[inline(always)]
fn unpack_angle_u8(v: u8) -> f32 {
    (v as f32) * (6.2831853 / 256.0)
}

#[inline(always)]
fn write_u16_le(buf: &mut [u8], off: &mut usize, v: u16) {
    let b = v.to_le_bytes();
    buf[*off] = b[0];
    buf[*off + 1] = b[1];
    *off += 2;
}

#[inline(always)]
fn write_i16_le(buf: &mut [u8], off: &mut usize, v: i16) {
    let b = v.to_le_bytes();
    buf[*off] = b[0];
    buf[*off + 1] = b[1];
    *off += 2;
}

#[inline(always)]
fn write_u32_le(buf: &mut [u8], off: &mut usize, v: u32) {
    let b = v.to_le_bytes();
    buf[*off] = b[0];
    buf[*off + 1] = b[1];
    buf[*off + 2] = b[2];
    buf[*off + 3] = b[3];
    *off += 4;
}

#[inline(always)]
fn write_i32_le(buf: &mut [u8], off: &mut usize, v: i32) {
    let b = v.to_le_bytes();
    buf[*off] = b[0];
    buf[*off + 1] = b[1];
    buf[*off + 2] = b[2];
    buf[*off + 3] = b[3];
    *off += 4;
}

#[inline(always)]
fn read_u16_le(buf: &[u8], off: &mut usize) -> u16 {
    let v = u16::from_le_bytes([buf[*off], buf[*off + 1]]);
    *off += 2;
    v
}

#[inline(always)]
fn read_i16_le(buf: &[u8], off: &mut usize) -> i16 {
    let v = i16::from_le_bytes([buf[*off], buf[*off + 1]]);
    *off += 2;
    v
}

#[inline(always)]
fn read_u32_le(buf: &[u8], off: &mut usize) -> u32 {
    let v = u32::from_le_bytes([buf[*off], buf[*off + 1], buf[*off + 2], buf[*off + 3]]);
    *off += 4;
    v
}

#[inline(always)]
fn read_i32_le(buf: &[u8], off: &mut usize) -> i32 {
    let v = i32::from_le_bytes([buf[*off], buf[*off + 1], buf[*off + 2], buf[*off + 3]]);
    *off += 4;
    v
}

// Varint helpers (Postcard / Protobuf style LEB128 + ZigZag)
#[inline(always)]
fn zigzag_i32(v: i32) -> u32 {
    ((v << 1) ^ (v >> 31)) as u32
}

#[inline(always)]
fn unzigzag_u32(v: u32) -> i32 {
    ((v >> 1) as i32) ^ -((v & 1) as i32)
}

#[inline(always)]
fn write_varint(buf: &mut [u8], off: &mut usize, mut v: u32) {
    while v >= 0x80 {
        buf[*off] = (v as u8) | 0x80;
        *off += 1;
        v >>= 7;
    }
    buf[*off] = v as u8;
    *off += 1;
}

#[inline(always)]
fn read_varint(buf: &[u8], off: &mut usize) -> u32 {
    let mut result = 0u32;
    let mut shift = 0u32;
    loop {
        let b = buf[*off];
        *off += 1;
        result |= ((b & 0x7f) as u32) << shift;
        if (b & 0x80) == 0 {
            break;
        }
        shift += 7;
    }
    result
}

#[no_mangle]
pub unsafe extern "C" fn zombies_ptr() -> *mut RawZombie {
    core::ptr::addr_of_mut!(ZOMBIES) as *mut RawZombie
}

#[no_mangle]
pub unsafe extern "C" fn decoded_zombies_ptr() -> *mut RawZombie {
    core::ptr::addr_of_mut!(DECODED_ZOMBIES) as *mut RawZombie
}

#[no_mangle]
pub unsafe extern "C" fn wire_out_ptr() -> *mut u8 {
    core::ptr::addr_of_mut!(WIRE_OUT) as *mut u8
}

#[no_mangle]
pub unsafe extern "C" fn instance_out_ptr() -> *mut f32 {
    core::ptr::addr_of_mut!(INSTANCE_OUT) as *mut f32
}

/// 1. Bincode-style fixed-width binary encoding (matches Outbreak's 15-19B per zombie layout)
#[no_mangle]
pub unsafe extern "C" fn rust_encode_bincode(count: usize, tick: u32, town_seed: u32) -> usize {
    let buf = &mut *core::ptr::addr_of_mut!(WIRE_OUT);
    let zombies = &*core::ptr::addr_of!(ZOMBIES);
    let mut off = 0usize;
    write_u32_le(buf, &mut off, tick);
    write_u16_le(buf, &mut off, count as u16);
    for i in 0..count {
        let z = &zombies[i];
        let custom = z.seed != town_seed;
        write_u16_le(buf, &mut off, z.id);
        buf[off] = z.state | if custom { 128 } else { 0 };
        off += 1;
        if custom {
            write_u32_le(buf, &mut off, z.seed);
        }
        write_i32_le(buf, &mut off, (z.x * 100.0) as i32);
        write_i32_le(buf, &mut off, (z.y * 100.0) as i32);
        write_u16_le(buf, &mut off, pack_angle_u16(z.aim));
        buf[off] = z.hp;
        buf[off + 1] = clamp_u8((z.hit_flash * 255.0) as i32);
        buf[off + 2] = clamp_u8((z.state_time * 20.0) as i32);
        buf[off + 3] = clamp_u8(((z.timer / 0.75) * 255.0) as i32);
        buf[off + 4] = clamp_u8((z.clamber * 255.0) as i32);
        off += 5;
    }
    off
}

#[no_mangle]
pub unsafe extern "C" fn rust_decode_bincode(town_seed: u32) -> usize {
    let buf = &*core::ptr::addr_of!(WIRE_OUT);
    let out = &mut *core::ptr::addr_of_mut!(DECODED_ZOMBIES);
    let mut off = 0usize;
    let _tick = read_u32_le(buf, &mut off);
    let count = read_u16_le(buf, &mut off) as usize;
    for i in 0..count {
        let id = read_u16_le(buf, &mut off);
        let code = buf[off];
        off += 1;
        let seed = if (code & 128) != 0 {
            read_u32_le(buf, &mut off)
        } else {
            town_seed
        };
        let x = (read_i32_le(buf, &mut off) as f32) * 0.01;
        let y = (read_i32_le(buf, &mut off) as f32) * 0.01;
        let aim = unpack_angle_u16(read_u16_le(buf, &mut off));
        let hp = buf[off];
        let hit_flash = (buf[off + 1] as f32) * (1.0 / 255.0);
        let state_time = (buf[off + 2] as f32) * 0.05;
        let timer = (buf[off + 3] as f32) * (0.75 / 255.0);
        let clamber = (buf[off + 4] as f32) * (1.0 / 255.0);
        off += 5;
        out[i] = RawZombie {
            id,
            state: code & 127,
            hp,
            seed,
            x,
            y,
            vx: 0.0,
            vy: 0.0,
            aim,
            hit_flash,
            state_time,
            timer,
            clamber,
        };
    }
    count
}

/// 2. Postcard-style ZigZag LEB128 varint encoding
#[no_mangle]
pub unsafe extern "C" fn rust_encode_postcard(count: usize, tick: u32) -> usize {
    let buf = &mut *core::ptr::addr_of_mut!(WIRE_OUT);
    let zombies = &*core::ptr::addr_of!(ZOMBIES);
    let mut off = 0usize;
    write_varint(buf, &mut off, tick);
    write_varint(buf, &mut off, count as u32);
    let mut prev_x = 0i32;
    let mut prev_y = 0i32;
    for i in 0..count {
        let z = &zombies[i];
        write_varint(buf, &mut off, z.id as u32);
        let qx = (z.x * 50.0) as i32;
        let qy = (z.y * 50.0) as i32;
        write_varint(buf, &mut off, zigzag_i32(qx - prev_x));
        write_varint(buf, &mut off, zigzag_i32(qy - prev_y));
        prev_x = qx;
        prev_y = qy;
        buf[off] = pack_angle_u8(z.aim);
        buf[off + 1] = (z.state & 0x07) | (if z.hit_flash > 0.01 { 8 } else { 0 }) | (if z.clamber > 0.01 { 16 } else { 0 });
        buf[off + 2] = z.hp;
        off += 3;
    }
    off
}

#[no_mangle]
pub unsafe extern "C" fn rust_decode_postcard() -> usize {
    let buf = &*core::ptr::addr_of!(WIRE_OUT);
    let out = &mut *core::ptr::addr_of_mut!(DECODED_ZOMBIES);
    let mut off = 0usize;
    let _tick = read_varint(buf, &mut off);
    let count = read_varint(buf, &mut off) as usize;
    let mut prev_x = 0i32;
    let mut prev_y = 0i32;
    for i in 0..count {
        let id = read_varint(buf, &mut off) as u16;
        let dx = unzigzag_u32(read_varint(buf, &mut off));
        let dy = unzigzag_u32(read_varint(buf, &mut off));
        prev_x += dx;
        prev_y += dy;
        let aim = unpack_angle_u8(buf[off]);
        let sf = buf[off + 1];
        let hp = buf[off + 2];
        off += 3;
        out[i].id = id;
        out[i].x = (prev_x as f32) * 0.02;
        out[i].y = (prev_y as f32) * 0.02;
        out[i].aim = aim;
        out[i].state = sf & 0x07;
        out[i].hp = hp;
    }
    count
}

/// 3. Bitcode-style Delta + Interest-Filtered + Bit-Packed Codec
/// Records current tick into HISTORY[tick % 32] and encodes delta against HISTORY[base_tick % 32]
#[no_mangle]
pub unsafe extern "C" fn rust_record_history(count: usize, tick: u32) {
    let zombies = &*core::ptr::addr_of!(ZOMBIES);
    let hist = &mut (&mut *core::ptr::addr_of_mut!(HISTORY))[(tick as usize) & (HISTORY_TICKS - 1)];
    for i in 0..count {
        let z = &zombies[i];
        hist[i] = QuantizedZombie {
            id: z.id,
            qx: clamp_i16((z.x * 50.0) as i32), // 2cm precision
            qy: clamp_i16((z.y * 50.0) as i32),
            qaim: pack_angle_u8(z.aim),
            state_flags: (z.state & 0x07)
                | (if z.hit_flash > 0.02 { 0x08 } else { 0 })
                | (if z.clamber > 0.02 { 0x10 } else { 0 }),
            hp: z.hp,
            timers: clamp_u8((z.state_time * 16.0) as i32),
        };
    }
}

#[no_mangle]
pub unsafe extern "C" fn rust_encode_delta_bitpack(
    count: usize,
    tick: u32,
    base_tick: u32,
    viewer_x: f32,
    viewer_y: f32,
    interest_radius: f32,
) -> usize {
    let buf = &mut *core::ptr::addr_of_mut!(WIRE_OUT);
    let cur_hist = &(&*core::ptr::addr_of!(HISTORY))[(tick as usize) & (HISTORY_TICKS - 1)];
    let base_hist = &(&*core::ptr::addr_of!(HISTORY))[(base_tick as usize) & (HISTORY_TICKS - 1)];
    let has_base = base_tick < tick && (tick - base_tick) < (HISTORY_TICKS as u32);
    let r2 = interest_radius * interest_radius;
    let qvx = (viewer_x * 50.0) as i32;
    let qvy = (viewer_y * 50.0) as i32;
    let qr2 = (r2 * 2500.0) as i32;

    let mut off = 0usize;
    write_u32_le(buf, &mut off, tick);
    write_u32_le(buf, &mut off, if has_base { base_tick } else { 0xffffffff });
    let count_pos = off;
    off += 2; // reserve u16 for written zombie count

    let mut written = 0u16;
    for i in 0..count {
        let c = &cur_hist[i];
        let dx_v = (c.qx as i32) - qvx;
        let dy_v = (c.qy as i32) - qvy;
        if dx_v * dx_v + dy_v * dy_v > qr2 {
            continue;
        }
        if has_base {
            let b = &base_hist[i];
            if b.id == c.id {
                let dx = (c.qx as i32) - (b.qx as i32);
                let dy = (c.qy as i32) - (b.qy as i32);
                let daim = (c.qaim as i8).wrapping_sub(b.qaim as i8);
                let same_meta = b.state_flags == c.state_flags && b.hp == c.hp;
                if dx == 0 && dy == 0 && daim == 0 && same_meta {
                    // Unchanged zombie: 0 bytes!
                    continue;
                }
                if dx >= -127 && dx <= 127 && dy >= -127 && dy <= 127 && same_meta {
                    // Small delta packet: header u16 (id | 0x8000) + dx(i8) + dy(i8) + daim(i8) = 5 bytes!
                    write_u16_le(buf, &mut off, c.id | 0x8000);
                    buf[off] = dx as i8 as u8;
                    buf[off + 1] = dy as i8 as u8;
                    buf[off + 2] = daim as u8;
                    off += 3;
                    written += 1;
                    continue;
                }
            }
        }
        // Full 9-byte quantized keyframe record for this zombie
        write_u16_le(buf, &mut off, c.id & 0x7fff);
        write_i16_le(buf, &mut off, c.qx);
        write_i16_le(buf, &mut off, c.qy);
        buf[off] = c.qaim;
        buf[off + 1] = c.state_flags;
        buf[off + 2] = c.hp;
        off += 3;
        written += 1;
    }

    let wb = written.to_le_bytes();
    buf[count_pos] = wb[0];
    buf[count_pos + 1] = wb[1];
    off
}

#[no_mangle]
pub unsafe extern "C" fn rust_decode_delta_bitpack(base_tick: u32) -> usize {
    let buf = &*core::ptr::addr_of!(WIRE_OUT);
    let base_hist = &(&*core::ptr::addr_of!(HISTORY))[(base_tick as usize) & (HISTORY_TICKS - 1)];
    let out = &mut *core::ptr::addr_of_mut!(DECODED_ZOMBIES);
    let mut off = 0usize;
    let _tick = read_u32_le(buf, &mut off);
    let _pkt_base = read_u32_le(buf, &mut off);
    let written = read_u16_le(buf, &mut off) as usize;

    for i in 0..written {
        let raw_id = read_u16_le(buf, &mut off);
        let is_delta = (raw_id & 0x8000) != 0;
        let id = raw_id & 0x7fff;
        let idx = ((id.wrapping_sub(1)) as usize) & (MAX_ZOMBIES - 1);
        if is_delta {
            let b = &base_hist[idx];
            let dx = buf[off] as i8 as i16;
            let dy = buf[off + 1] as i8 as i16;
            let daim = buf[off + 2] as i8;
            off += 3;
            let qx = b.qx.wrapping_add(dx);
            let qy = b.qy.wrapping_add(dy);
            let qaim = (b.qaim as i8).wrapping_add(daim) as u8;
            out[i].id = id;
            out[i].x = (qx as f32) * 0.02;
            out[i].y = (qy as f32) * 0.02;
            out[i].aim = unpack_angle_u8(qaim);
            out[i].state = b.state_flags & 0x07;
            out[i].hp = b.hp;
        } else {
            let qx = read_i16_le(buf, &mut off);
            let qy = read_i16_le(buf, &mut off);
            let qaim = buf[off];
            let sf = buf[off + 1];
            let hp = buf[off + 2];
            off += 3;
            out[i].id = id;
            out[i].x = (qx as f32) * 0.02;
            out[i].y = (qy as f32) * 0.02;
            out[i].aim = unpack_angle_u8(qaim);
            out[i].state = sf & 0x07;
            out[i].hp = hp;
        }
    }
    written
}

/// 4. Full Shared Rust Durable Object Tick in WASM:
/// Steps 300 zombies (spatial hash separation + flow steering + obstacle pushout + state timers),
/// records history for lag compensation & delta snapshots, and encodes 4 player delta packets.
#[no_mangle]
pub unsafe extern "C" fn rust_step_world_and_encode_room(
    count: usize,
    tick: u32,
    dt: f32,
) -> usize {
    let zombies = &mut *core::ptr::addr_of_mut!(ZOMBIES);
    let heads = &mut *core::ptr::addr_of_mut!(CELL_HEAD);
    let nexts = &mut *core::ptr::addr_of_mut!(AGENT_NEXT);
    let survivors = &*core::ptr::addr_of!(SURVIVOR_POS);

    // 1. Clear spatial hash
    heads.fill(-1);
    for i in 0..count {
        let z = &zombies[i];
        if z.state == 7 {
            continue;
        }
        let cx = ((z.x * 0.6666667) as isize).clamp(0, (HASH_W - 1) as isize) as usize;
        let cy = ((z.y * 0.6666667) as isize).clamp(0, (HASH_W - 1) as isize) as usize;
        let cell = cy * HASH_W + cx;
        nexts[i] = heads[cell];
        heads[cell] = i as i16;
    }

    // 2. Step each zombie: steer toward nearest survivor + O(1) neighbor separation
    for i in 0..count {
        let mut z = zombies[i];
        if z.state == 7 {
            continue;
        }
        z.state_time += dt;
        // Pick nearest of 4 survivors
        let mut best_dx = survivors[0].0 - z.x;
        let mut best_dy = survivors[0].1 - z.y;
        let mut best_d2 = best_dx * best_dx + best_dy * best_dy;
        for s in 1..MAX_SURVIVORS {
            let dx = survivors[s].0 - z.x;
            let dy = survivors[s].1 - z.y;
            let d2 = dx * dx + dy * dy;
            if d2 < best_d2 {
                best_d2 = d2;
                best_dx = dx;
                best_dy = dy;
            }
        }

        // Separation from spatial hash 3x3 neighborhood
        let cx = ((z.x * 0.6666667) as isize).clamp(1, (HASH_W - 2) as isize);
        let cy = ((z.y * 0.6666667) as isize).clamp(1, (HASH_W - 2) as isize);
        let mut sep_x = 0.0f32;
        let mut sep_y = 0.0f32;
        for dy_c in -1..=1 {
            let row = ((cy + dy_c) as usize) * HASH_W;
            for dx_c in -1..=1 {
                let mut cur = heads[row + ((cx + dx_c) as usize)];
                while cur >= 0 {
                    let j = cur as usize;
                    if j != i {
                        let oz = &zombies[j];
                        let rx = z.x - oz.x;
                        let ry = z.y - oz.y;
                        let d2 = rx * rx + ry * ry;
                        if d2 > 1e-4 && d2 < 0.64 {
                            let inv = 1.0 / sqrt_f32(d2);
                            let push = (0.8 - d2 * inv) * 1.4;
                            sep_x += rx * inv * push;
                            sep_y += ry * inv * push;
                        }
                    }
                    cur = nexts[j];
                }
            }
        }

        let d = sqrt_f32(best_d2).max(1e-3);
        let speed = if z.state == 3 { 2.65 } else { 0.95 };
        let dir_x = (best_dx / d) + sep_x;
        let dir_y = (best_dy / d) + sep_y;
        let dir_len = sqrt_f32(dir_x * dir_x + dir_y * dir_y).max(1e-3);
        z.vx = (dir_x / dir_len) * speed;
        z.vy = (dir_y / dir_len) * speed;
        z.x = (z.x + z.vx * dt).clamp(1.0, 95.0);
        z.y = (z.y + z.vy * dt).clamp(1.0, 95.0);
        zombies[i] = z;
    }

    // 3. Record quantized state into history ring buffer
    rust_record_history(count, tick);

    // 4. If snapshot tick (every 3rd tick = 20 Hz), encode delta snapshots for all 4 players
    let mut total_bytes = 0usize;
    if tick % 3 == 0 {
        let base_tick = if tick >= 3 { tick - 3 } else { 0xffffffff };
        for s in 0..MAX_SURVIVORS {
            let (sx, sy) = survivors[s];
            total_bytes += rust_encode_delta_bitpack(count, tick, base_tick, sx, sy, 60.0);
        }
    }
    total_bytes
}

/// 5. Fixed-Point Q16.16 deterministic step (100% bit-identical across x86_64, ARM64, V8, JSC, WASM)
#[no_mangle]
pub unsafe extern "C" fn rust_init_fixed_point(count: usize) {
    let fx = &mut *core::ptr::addr_of_mut!(FP_X);
    let fy = &mut *core::ptr::addr_of_mut!(FP_Y);
    let fvx = &mut *core::ptr::addr_of_mut!(FP_VX);
    let fvy = &mut *core::ptr::addr_of_mut!(FP_VY);
    let faim = &mut *core::ptr::addr_of_mut!(FP_AIM);
    for i in 0..count {
        let zx = 6 + ((i * 17) % 84) as i32;
        let zy = 6 + ((i * 29) % 84) as i32;
        fx[i] = zx << 16;
        fy[i] = zy << 16;
        fvx[i] = 0;
        fvy[i] = 0;
        faim[i] = ((i * 2600) & 0xffff) as u16;
    }
}

#[no_mangle]
pub unsafe extern "C" fn rust_step_fixed_point(count: usize, ticks: usize) -> u32 {
    let fx = &mut *core::ptr::addr_of_mut!(FP_X);
    let fy = &mut *core::ptr::addr_of_mut!(FP_Y);
    let fvx = &mut *core::ptr::addr_of_mut!(FP_VX);
    let fvy = &mut *core::ptr::addr_of_mut!(FP_VY);
    let faim = &mut *core::ptr::addr_of_mut!(FP_AIM);
    let target_x = (27.7 * 65536.0) as i32;
    let target_y = (41.0 * 65536.0) as i32;

    for _t in 0..ticks {
        for i in 0..count {
            let dx = (target_x - fx[i]) >> 8; // Q8.8 to avoid overflow
            let dy = (target_y - fy[i]) >> 8;
            let dist_approx = dx.abs().max(dy.abs()) + (dx.abs().min(dy.abs()) >> 1);
            if dist_approx > 16 {
                // Speed ~ 2.0 m/s => step per 60Hz tick = 2.0/60 * 65536 = 2185 Q16.16 units
                let vx = (dx * 2185) / dist_approx;
                let vy = (dy * 2185) / dist_approx;
                fvx[i] = vx;
                fvy[i] = vy;
                fx[i] = fx[i].wrapping_add(vx);
                fy[i] = fy[i].wrapping_add(vy);
                faim[i] = faim[i].wrapping_add(91);
            }
        }
    }

    // FNV-1a hash of all fixed-point positions for bit-exact determinism proof
    let mut h = 2166136261u32;
    for i in 0..count {
        h ^= fx[i] as u32;
        h = h.wrapping_mul(16777619);
        h ^= fy[i] as u32;
        h = h.wrapping_mul(16777619);
    }
    h
}
