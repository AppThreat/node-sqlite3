{
  "includes": [ "deps/common-sqlite.gypi" ],
  "variables": {
      "sqlite%":"internal",
      "sqlite_libname%":"sqlite3",
      "module_name": "node_sqlite3",
  },
  "targets": [
    {
      "target_name": "<(module_name)",
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "xcode_settings": { "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "CLANG_CXX_LIBRARY": "libc++",
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "MACOSX_DEPLOYMENT_TARGET": "12.0",
      },
      "msvs_settings": {
        "VCCLCompilerTool": { "ExceptionHandling": 1 },
      },
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"],
      "conditions": [
        ["sqlite != 'internal'", {
            "include_dirs": [
              "<!@(node -p \"require('node-addon-api').include\")", "<(sqlite)/include" ],
            # The vendored build gets these from deps/sqlite3.gyp's
            # direct_dependent_settings, which an external SQLite never
            # reaches — so without them the session, preupdate and column
            # metadata declarations in the external sqlite3.h stay behind
            # their #ifdefs and src/session.h fails to compile
            # ("'sqlite3_session' does not name a type"). They describe
            # what this addon's sources need to *see*; the external library
            # must have been built with them too, or the link fails.
            "defines": [
              "SQLITE_ENABLE_SESSION",
              "SQLITE_ENABLE_PREUPDATE_HOOK",
              "SQLITE_ENABLE_COLUMN_METADATA"
            ],
            "libraries": [
               "-l<(sqlite_libname)"
            ],
            "conditions": [
              [ "OS=='linux'", {"libraries+":["-Wl,-rpath=<@(sqlite)/lib"]} ],
              [ "OS!='win'", {"libraries+":["-L<@(sqlite)/lib"]} ]
            ],
            'msvs_settings': {
              'VCLinkerTool': {
                'AdditionalLibraryDirectories': [
                  '<(sqlite)/lib'
                ],
              },
            }
        },
        {
            "dependencies": [
              "<!(node -p \"require('node-addon-api').gyp\")",
              "deps/sqlite3.gyp:sqlite3"
            ]
        }
        ]
      ],
      "sources": [
        "src/backup.cc",
        "src/blob.cc",
        "src/convert.cc",
        "src/database.cc",
        "src/function.cc",
        "src/node_sqlite3.cc",
        "src/session.cc",
        "src/statement.cc"
      ],
      "defines": [ "NAPI_VERSION=<(napi_build_version)", "NAPI_DISABLE_CPP_EXCEPTIONS=1" ]
    }
  ]
}
