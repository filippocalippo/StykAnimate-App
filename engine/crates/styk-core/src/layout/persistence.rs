//! The host-injected layout service. The layout codec and merge remain owned by `store`.
use super::{
    LayoutError,
    store::{FILE_NAME, LayoutFile, MAX_BYTES},
};
use std::sync::Arc;
use styk_services::{Cancel, storage::Storage};

/// Keeps the platform service available to the layout host without a second copy of layout state.
pub struct LayoutStore {
    storage: Arc<dyn Storage>,
}

impl LayoutStore {
    pub fn new(storage: Arc<dyn Storage>) -> Self {
        Self { storage }
    }

    pub async fn load(&self) -> Result<Option<LayoutFile>, LayoutError> {
        let bytes = self
            .storage
            .load(FILE_NAME, MAX_BYTES)
            .await
            .map_err(|error| LayoutError::Storage(error.to_string()))?;
        bytes.as_deref().map(LayoutFile::decode).transpose()
    }

    pub async fn save(
        &self,
        file: &LayoutFile,
        now: u64,
        cancel: &Cancel,
    ) -> Result<(), LayoutError> {
        file.save(self.storage.as_ref(), now, cancel).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use styk_services::{storage::fake::MemoryStorage, worker::run_future};

    #[test]
    fn injected_storage_loads_merges_and_refuses_newer_versions() {
        let storage = Arc::new(MemoryStorage::default());
        let store = LayoutStore::new(storage.clone());
        assert_eq!(run_future(store.load()).unwrap(), None);
        let file = LayoutFile::default();
        run_future(store.save(&file, 0, &Cancel::new())).unwrap();
        assert_eq!(run_future(store.load()).unwrap(), Some(file.clone()));
        let newer = br#"{"version":4}"#;
        storage.put("layouts.json", newer.to_vec());
        assert_eq!(run_future(store.load()), Err(LayoutError::FutureVersion));
        assert!(run_future(store.save(&file, 1, &Cancel::new())).is_err());
        assert_eq!(storage.get("layouts.json").unwrap(), newer);
    }
}
