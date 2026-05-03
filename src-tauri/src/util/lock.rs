use std::sync::{Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard};

pub fn lock_read<'a, T>(
    lock: &'a RwLock<T>,
    label: &str,
) -> Result<RwLockReadGuard<'a, T>, String> {
    lock.read()
        .map_err(|e| format!("{label} lock poisoned: {e}"))
}

pub fn lock_write<'a, T>(
    lock: &'a RwLock<T>,
    label: &str,
) -> Result<RwLockWriteGuard<'a, T>, String> {
    lock.write()
        .map_err(|e| format!("{label} lock poisoned: {e}"))
}

pub fn lock_mutex<'a, T>(lock: &'a Mutex<T>, label: &str) -> Result<MutexGuard<'a, T>, String> {
    lock.lock()
        .map_err(|e| format!("{label} lock poisoned: {e}"))
}
