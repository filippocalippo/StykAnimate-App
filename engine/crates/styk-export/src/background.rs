//! A draw list without its scene background.

use std::sync::Arc;

use styk_draw::DrawList;

/// The draw list without the scene's background records: the figures on transparency, what a document with no
/// background exports (and what WebM's alpha plane is for). Tools use it to make frames with real translucency.
pub fn without_background(list: &Arc<DrawList>) -> Arc<DrawList> {
    let mut list = (**list).clone();
    let background = list.background_prims as usize;
    list.prims[..background].iter_mut().for_each(|p| p.kind = 0);
    Arc::new(list)
}
