# The native app's in-app browser (P6-NATIVE-TODAY, SCR-EML-03): a local Expo module, autolinked from apps/tech-native/modules.
Pod::Spec.new do |s|
  s.name           = 'BwBrowser'
  s.version        = '0.0.0'
  s.summary        = 'Opens a web page of the server in SFSafariViewController, the in-app browser'
  s.description    = 'Opens a web page of the server in SFSafariViewController, the in-app browser'
  s.license        = 'AGPL-3.0-or-later'
  s.author         = 'Brightwater'
  s.homepage       = 'https://github.com/JohnnyEgghead/right-on-time'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/JohnnyEgghead/right-on-time.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.{h,m,swift}'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'SWIFT_COMPILATION_MODE' => 'wholemodule' }
end
