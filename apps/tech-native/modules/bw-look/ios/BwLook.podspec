# The native app's look reader (P6-NATIVE-SHELL): a local Expo module, autolinked from apps/tech-native/modules.
Pod::Spec.new do |s|
  s.name           = 'BwLook'
  s.version        = '0.0.0'
  s.summary        = 'Reads drawn values from the UIKit view hierarchy for the look values comparator'
  s.description    = 'Reads drawn values from the UIKit view hierarchy for the look values comparator'
  s.license        = 'AGPL-3.0-or-later'
  s.author         = 'Brightwater'
  s.homepage       = 'https://github.com/JohnnyEgghead/right-on-time'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/JohnnyEgghead/right-on-time.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.{h,m,swift}'
  # F-988: the look reader is compiled in unless the project was generated for the TestFlight archive (BW_RELEASE=1, set by prebuild.sh --release).
  rig = ENV['BW_RELEASE'] == '1' ? '' : '-DBW_RIG'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'SWIFT_COMPILATION_MODE' => 'wholemodule', 'OTHER_SWIFT_FLAGS' => "$(inherited) #{rig}" }
end
