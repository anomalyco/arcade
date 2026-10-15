#![no_std]
#![allow(dead_code)]

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

const MAX_ENTITIES: usize = 2048;
const HASH_W: usize = 64;
const HASH_CELLS: usize = HASH_W * HASH_W;

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

// Bevy-style Archetype Table: contiguous typed component columns for Archetype(Position, Velocity, AiAgent, Health, AnimPhase)
#[repr(C)]
#[derive(Clone, Copy)]
pub struct PosComp {
    pub x: f32,
    pub y: f32,
    pub aim: f32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct VelComp {
    pub vx: f32,
    pub vy: f32,
    pub speed_scale: f32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct AiComp {
    pub id: u16,
    pub state: u8,
    pub hp: u8,
}

static mut COL_POS: [PosComp; MAX_ENTITIES] = [PosComp { x: 0.0, y: 0.0, aim: 0.0 }; MAX_ENTITIES];
static mut COL_VEL: [VelComp; MAX_ENTITIES] = [VelComp { vx: 0.0, vy: 0.0, speed_scale: 1.0 }; MAX_ENTITIES];
static mut COL_AI: [AiComp; MAX_ENTITIES] = [AiComp { id: 0, state: 0, hp: 100 }; MAX_ENTITIES];
static mut COL_PHASE: [f32; MAX_ENTITIES] = [0.0; MAX_ENTITIES];

// Previous tick quantized positions for delta snapshot encoding
static mut PREV_QX: [i16; MAX_ENTITIES] = [0; MAX_ENTITIES];
static mut PREV_QY: [i16; MAX_ENTITIES] = [0; MAX_ENTITIES];

static mut CELL_HEAD: [i16; HASH_CELLS] = [-1; HASH_CELLS];
static mut AGENT_NEXT: [i16; MAX_ENTITIES] = [-1; MAX_ENTITIES];

static mut WIRE_OUT: [u8; 32768] = [0; 32768];
static mut INST_OUT: [f32; MAX_ENTITIES * 8 * 12] = [0.0; MAX_ENTITIES * 8 * 12];

#[no_mangle]
pub unsafe extern "C" fn pos_ptr() -> *mut PosComp {
    core::ptr::addr_of_mut!(COL_POS) as *mut PosComp
}

#[no_mangle]
pub unsafe extern "C" fn vel_ptr() -> *mut VelComp {
    core::ptr::addr_of_mut!(COL_VEL) as *mut VelComp
}

#[no_mangle]
pub unsafe extern "C" fn ai_ptr() -> *mut AiComp {
    core::ptr::addr_of_mut!(COL_AI) as *mut AiComp
}

#[no_mangle]
pub unsafe extern "C" fn wire_ptr() -> *mut u8 {
    core::ptr::addr_of_mut!(WIRE_OUT) as *mut u8
}

#[no_mangle]
pub unsafe extern "C" fn inst_ptr() -> *mut f32 {
    core::ptr::addr_of_mut!(INST_OUT) as *mut f32
}

#[no_mangle]
pub unsafe extern "C" fn bevy_ecs_init(count: usize) {
    let pos = &mut *core::ptr::addr_of_mut!(COL_POS);
    let vel = &mut *core::ptr::addr_of_mut!(COL_VEL);
    let ai = &mut *core::ptr::addr_of_mut!(COL_AI);
    let phase = &mut *core::ptr::addr_of_mut!(COL_PHASE);
    let pqx = &mut *core::ptr::addr_of_mut!(PREV_QX);
    let pqy = &mut *core::ptr::addr_of_mut!(PREV_QY);

    for i in 0..count {
        let cluster = i / 4;
        let member = i & 3;
        let x = 6.0 + ((cluster * 13) % 83) as f32 + (member as f32 - 1.5) * 0.55;
        let y = 6.0 + ((cluster * 29) % 79) as f32 + ((member & 1) as f32 - 0.5) * 0.55;
        pos[i] = PosComp {
            x,
            y,
            aim: (i as f32 * 0.3) % 6.283185,
        };
        vel[i] = VelComp {
            vx: 0.0,
            vy: 0.0,
            speed_scale: 0.9 + ((i % 5) as f32) * 0.05,
        };
        ai[i] = AiComp {
            id: (i + 1) as u16,
            state: if i % 2 == 0 { 3 } else { 0 },
            hp: 100,
        };
        phase[i] = (i as f32 * 0.27) % 1.0;
        pqx[i] = (x * 50.0) as i16;
        pqy[i] = (y * 50.0) as i16;
    }
}

#[no_mangle]
pub unsafe extern "C" fn bevy_ecs_ai(count: usize, dt: f32) {
    let pos = &mut *core::ptr::addr_of_mut!(COL_POS);
    let vel = &mut *core::ptr::addr_of_mut!(COL_VEL);
    let ai = &*core::ptr::addr_of!(COL_AI);
    let heads = &mut *core::ptr::addr_of_mut!(CELL_HEAD);
    let nexts = &mut *core::ptr::addr_of_mut!(AGENT_NEXT);

    heads.fill(-1);
    for i in 0..count {
        let p = &pos[i];
        let cx = ((p.x * 0.6667) as isize).clamp(0, 63) as usize;
        let cy = ((p.y * 0.6667) as isize).clamp(0, 63) as usize;
        let c = cy * HASH_W + cx;
        nexts[i] = heads[c];
        heads[c] = i as i16;
    }

    for i in 0..count {
        let mut p = pos[i];
        let mut v = vel[i];
        let a = ai[i];
        let dx = 27.7 - p.x;
        let dy = 41.0 - p.y;
        let d = sqrt_f32(dx * dx + dy * dy).max(1e-3);

        let cx = ((p.x * 0.6667) as isize).clamp(1, 62);
        let cy = ((p.y * 0.6667) as isize).clamp(1, 62);
        let mut sep_x = 0.0f32;
        let mut sep_y = 0.0f32;
        for dyc in -1..=1 {
            let row = ((cy + dyc) as usize) * HASH_W;
            for dxc in -1..=1 {
                let mut cur = heads[row + ((cx + dxc) as usize)];
                while cur >= 0 {
                    let j = cur as usize;
                    if j != i {
                        let op = &pos[j];
                        let rx = p.x - op.x;
                        let ry = p.y - op.y;
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
        let spd = (if a.state == 3 { 2.65 } else { 0.95 }) * v.speed_scale;
        let dir_x = dx / d + sep_x;
        let dir_y = dy / d + sep_y;
        let dir_len = sqrt_f32(dir_x * dir_x + dir_y * dir_y).max(1e-3);
        v.vx = (dir_x / dir_len) * spd;
        v.vy = (dir_y / dir_len) * spd;
        p.x = (p.x + v.vx * dt).clamp(1.0, 95.0);
        p.y = (p.y + v.vy * dt).clamp(1.0, 95.0);
        pos[i] = p;
        vel[i] = v;
    }
}

#[no_mangle]
pub unsafe extern "C" fn bevy_ecs_encode(count: usize) -> usize {
    let pos = &*core::ptr::addr_of!(COL_POS);
    let ai = &*core::ptr::addr_of!(COL_AI);
    let pqx = &mut *core::ptr::addr_of_mut!(PREV_QX);
    let pqy = &mut *core::ptr::addr_of_mut!(PREV_QY);
    let wire = &mut *core::ptr::addr_of_mut!(WIRE_OUT);

    let mut w_off = 4usize;
    let mut written = 0u16;
    let qvx = (27.7 * 50.0) as i32;
    let qvy = (41.0 * 50.0) as i32;
    let qr2 = (60.0 * 60.0 * 2500.0) as i32;

    for i in 0..count {
        let p = &pos[i];
        let a = &ai[i];
        let qx = (p.x * 50.0) as i16;
        let qy = (p.y * 50.0) as i16;
        let dxv = (qx as i32) - qvx;
        let dyv = (qy as i32) - qvy;
        if dxv * dxv + dyv * dyv <= qr2 {
            let dqx = (qx as i32) - (pqx[i] as i32);
            let dqy = (qy as i32) - (pqy[i] as i32);
            if dqx != 0 || dqy != 0 {
                if dqx >= -127 && dqx <= 127 && dqy >= -127 && dqy <= 127 {
                    let id_b = (a.id | 0x8000).to_le_bytes();
                    wire[w_off] = id_b[0];
                    wire[w_off + 1] = id_b[1];
                    wire[w_off + 2] = dqx as i8 as u8;
                    wire[w_off + 3] = dqy as i8 as u8;
                    wire[w_off + 4] = 0;
                    w_off += 5;
                } else {
                    let id_b = a.id.to_le_bytes();
                    let xb = qx.to_le_bytes();
                    let yb = qy.to_le_bytes();
                    wire[w_off] = id_b[0];
                    wire[w_off + 1] = id_b[1];
                    wire[w_off + 2] = xb[0];
                    wire[w_off + 3] = xb[1];
                    wire[w_off + 4] = yb[0];
                    wire[w_off + 5] = yb[1];
                    wire[w_off + 6] = 0;
                    wire[w_off + 7] = a.state;
                    wire[w_off + 8] = a.hp;
                    w_off += 9;
                }
                written += 1;
            }
        }
        pqx[i] = qx;
        pqy[i] = qy;
    }
    let wb = written.to_le_bytes();
    wire[0] = wb[0];
    wire[1] = wb[1];
    w_off
}

#[no_mangle]
pub unsafe extern "C" fn bevy_ecs_render_pack(count: usize, dt: f32) {
    let pos = &*core::ptr::addr_of!(COL_POS);
    let vel = &*core::ptr::addr_of!(COL_VEL);
    let phase = &mut *core::ptr::addr_of_mut!(COL_PHASE);
    let inst = &mut *core::ptr::addr_of_mut!(INST_OUT);

    let mut i_off = 0usize;
    for i in 0..count {
        let p = &pos[i];
        let v = &vel[i];
        let spd = sqrt_f32(v.vx * v.vx + v.vy * v.vy);
        let ph = (phase[i] + spd * dt * 0.85) % 1.0;
        phase[i] = ph;
        let cy = fast_cos(p.aim);
        let sy = fast_sin(p.aim);
        let hip_y = 0.86 + fast_sin(ph * 6.283185) * 0.035;
        for part in 0..8 {
            let side = if (part & 1) == 0 { -1.0f32 } else { 1.0f32 };
            let swing = fast_sin(ph * 6.283185 + side * 1.570796) * 0.34;
            inst[i_off] = p.x + cy * (swing * 0.18) - sy * (side * 0.13);
            inst[i_off + 1] = hip_y - (part as f32) * 0.09;
            inst[i_off + 2] = p.y + sy * (swing * 0.18) + cy * (side * 0.13);
            inst[i_off + 3] = p.aim;
            inst[i_off + 4] = 0.86;
            inst[i_off + 5] = 0.84;
            inst[i_off + 6] = 0.80;
            inst[i_off + 7] = 1.0;
            inst[i_off + 8] = swing;
            inst[i_off + 9] = side * 0.05;
            inst[i_off + 10] = 1.0;
            inst[i_off + 11] = 0.0;
            i_off += 12;
        }
    }
}

#[no_mangle]
pub unsafe extern "C" fn bevy_ecs_step_all(count: usize, dt: f32) -> usize {
    bevy_ecs_ai(count, dt);
    let w_off = bevy_ecs_encode(count);
    bevy_ecs_render_pack(count, dt);
    w_off
}
