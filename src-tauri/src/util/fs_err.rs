pub trait IoErrExt<T> {
    fn with_op(self, op: &str) -> Result<T, String>;
}

impl<T> IoErrExt<T> for std::io::Result<T> {
    fn with_op(self, op: &str) -> Result<T, String> {
        self.map_err(|e| format!("{op}: {e}"))
    }
}
