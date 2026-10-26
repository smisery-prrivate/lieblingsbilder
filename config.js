// Lieblingsbilder cloud settings. Like Snapdoc, the app gets its own Supabase project (not shared
// with other apps): a private photo collection gets its own account list, mail limit and storage,
// and new sign-ups can be switched off once the owner has signed in.
// A publishable key is designed to be shipped publicly; row level security on the server decides
// what a signed-in user may read or write, and visitors who are not signed in get nothing.
// Both values empty: the app runs on this device only, encrypted, without cloud sync.
// If the project address changes, also change the connect-src entry of the
// Content-Security-Policy in index.html.
window.APP_CONFIG = window.APP_CONFIG || {
  supabaseUrl: 'https://bqvibovnrhwgavwkrsbc.supabase.co',
  supabaseKey: 'sb_publishable_sQpNABz4i_TwCtBTyYR_iw_QjTJ6uHE'
};
