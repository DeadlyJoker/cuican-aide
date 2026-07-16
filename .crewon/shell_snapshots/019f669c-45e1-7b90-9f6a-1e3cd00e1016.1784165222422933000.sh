# Snapshot file
# Unset all aliases to avoid conflicts with functions
unalias -a 2>/dev/null || true
# Functions
VCS_INFO_formats () {
	setopt localoptions noksharrays NO_shwordsplit
	local msg tmp
	local -i i
	local -A hook_com
	hook_com=(action "$1" action_orig "$1" branch "$2" branch_orig "$2" base "$3" base_orig "$3" staged "$4" staged_orig "$4" unstaged "$5" unstaged_orig "$5" revision "$6" revision_orig "$6" misc "$7" misc_orig "$7" vcs "${vcs}" vcs_orig "${vcs}") 
	hook_com[base-name]="${${hook_com[base]}:t}" 
	hook_com[base-name_orig]="${hook_com[base-name]}" 
	hook_com[subdir]="$(VCS_INFO_reposub ${hook_com[base]})" 
	hook_com[subdir_orig]="${hook_com[subdir]}" 
	: vcs_info-patch-9b9840f2-91e5-4471-af84-9e9a0dc68c1b
	for tmp in base base-name branch misc revision subdir
	do
		hook_com[$tmp]="${hook_com[$tmp]//\%/%%}" 
	done
	VCS_INFO_hook 'post-backend'
	if [[ -n ${hook_com[action]} ]]
	then
		zstyle -a ":vcs_info:${vcs}:${usercontext}:${rrn}" actionformats msgs
		(( ${#msgs} < 1 )) && msgs[1]=' (%s)-[%b|%a]%u%c-' 
	else
		zstyle -a ":vcs_info:${vcs}:${usercontext}:${rrn}" formats msgs
		(( ${#msgs} < 1 )) && msgs[1]=' (%s)-[%b]%u%c-' 
	fi
	if [[ -n ${hook_com[staged]} ]]
	then
		zstyle -s ":vcs_info:${vcs}:${usercontext}:${rrn}" stagedstr tmp
		[[ -z ${tmp} ]] && hook_com[staged]='S'  || hook_com[staged]=${tmp} 
	fi
	if [[ -n ${hook_com[unstaged]} ]]
	then
		zstyle -s ":vcs_info:${vcs}:${usercontext}:${rrn}" unstagedstr tmp
		[[ -z ${tmp} ]] && hook_com[unstaged]='U'  || hook_com[unstaged]=${tmp} 
	fi
	if [[ ${quiltmode} != 'standalone' ]] && VCS_INFO_hook "pre-addon-quilt"
	then
		local REPLY
		VCS_INFO_quilt addon
		hook_com[quilt]="${REPLY}" 
		unset REPLY
	elif [[ ${quiltmode} == 'standalone' ]]
	then
		hook_com[quilt]=${hook_com[misc]} 
	fi
	(( ${#msgs} > maxexports )) && msgs[$(( maxexports + 1 )),-1]=() 
	for i in {1..${#msgs}}
	do
		if VCS_INFO_hook "set-message" $(( $i - 1 )) "${msgs[$i]}"
		then
			zformat -f msg ${msgs[$i]} a:${hook_com[action]} b:${hook_com[branch]} c:${hook_com[staged]} i:${hook_com[revision]} m:${hook_com[misc]} r:${hook_com[base-name]} s:${hook_com[vcs]} u:${hook_com[unstaged]} Q:${hook_com[quilt]} R:${hook_com[base]} S:${hook_com[subdir]}
			msgs[$i]=${msg} 
		else
			msgs[$i]=${hook_com[message]} 
		fi
	done
	hook_com=() 
	backend_misc=() 
	return 0
}
_SUSEconfig () {
	# undefined
	builtin autoload -XUz
}
__arguments () {
	# undefined
	builtin autoload -XUz
}
__conda_activate () {
	if [ -n "${CONDA_PS1_BACKUP:+x}" ]
	then
		PS1="$CONDA_PS1_BACKUP" 
		\unset CONDA_PS1_BACKUP
	fi
	\local ask_conda
	ask_conda="$(PS1="${PS1:-}" __conda_exe shell.posix "$@")"  || \return
	\eval "$ask_conda"
	__conda_hashr
}
__conda_exe () {
	(
		if [ -n "${_CE_M:+x}" ] && [ -n "${_CE_CONDA:+x}" ]
		then
			"$CONDA_EXE" $_CE_M $_CE_CONDA "$@"
		else
			"$CONDA_EXE" "$@"
		fi
	)
}
__conda_hashr () {
	if [ -n "${ZSH_VERSION:+x}" ]
	then
		\rehash
	elif [ -n "${POSH_VERSION:+x}" ]
	then
		:
	else
		\hash -r
	fi
}
__conda_reactivate () {
	echo "'__conda_reactivate' is deprecated and will be removed in 25.9. Use '__conda_activate reactivate' instead." >&2
	__conda_activate reactivate
}
__git_prompt_git () {
	GIT_OPTIONAL_LOCKS=0 command git "$@"
}
_a2ps () {
	# undefined
	builtin autoload -XUz
}
_a2utils () {
	# undefined
	builtin autoload -XUz
}
_aap () {
	# undefined
	builtin autoload -XUz
}
_abcde () {
	# undefined
	builtin autoload -XUz
}
_absolute_command_paths () {
	# undefined
	builtin autoload -XUz
}
_ack () {
	# undefined
	builtin autoload -XUz
}
_acpi () {
	# undefined
	builtin autoload -XUz
}
_acpitool () {
	# undefined
	builtin autoload -XUz
}
_acroread () {
	# undefined
	builtin autoload -XUz
}
_adb () {
	# undefined
	builtin autoload -XUz
}
_add-zle-hook-widget () {
	# undefined
	builtin autoload -XUz
}
_add-zsh-hook () {
	# undefined
	builtin autoload -XUz
}
_alias () {
	# undefined
	builtin autoload -XUz
}
_aliases () {
	# undefined
	builtin autoload -XUz
}
_all_labels () {
	# undefined
	builtin autoload -XUz
}
_all_matches () {
	# undefined
	builtin autoload -XUz
}
_alsa-utils () {
	# undefined
	builtin autoload -XUz
}
_alternative () {
	# undefined
	builtin autoload -XUz
}
_analyseplugin () {
	# undefined
	builtin autoload -XUz
}
_ansible () {
	# undefined
	builtin autoload -XUz
}
_ant () {
	# undefined
	builtin autoload -XUz
}
_antiword () {
	# undefined
	builtin autoload -XUz
}
_apachectl () {
	# undefined
	builtin autoload -XUz
}
_apm () {
	# undefined
	builtin autoload -XUz
}
_approximate () {
	# undefined
	builtin autoload -XUz
}
_apt () {
	# undefined
	builtin autoload -XUz
}
_apt-file () {
	# undefined
	builtin autoload -XUz
}
_apt-move () {
	# undefined
	builtin autoload -XUz
}
_apt-show-versions () {
	# undefined
	builtin autoload -XUz
}
_aptitude () {
	# undefined
	builtin autoload -XUz
}
_arch_archives () {
	# undefined
	builtin autoload -XUz
}
_arch_namespace () {
	# undefined
	builtin autoload -XUz
}
_arg_compile () {
	# undefined
	builtin autoload -XUz
}
_arguments () {
	# undefined
	builtin autoload -XUz
}
_arp () {
	# undefined
	builtin autoload -XUz
}
_arping () {
	# undefined
	builtin autoload -XUz
}
_arrays () {
	# undefined
	builtin autoload -XUz
}
_asciidoctor () {
	# undefined
	builtin autoload -XUz
}
_asciinema () {
	# undefined
	builtin autoload -XUz
}
_assign () {
	# undefined
	builtin autoload -XUz
}
_at () {
	# undefined
	builtin autoload -XUz
}
_attr () {
	# undefined
	builtin autoload -XUz
}
_augeas () {
	# undefined
	builtin autoload -XUz
}
_auto-apt () {
	# undefined
	builtin autoload -XUz
}
_autocd () {
	# undefined
	builtin autoload -XUz
}
_avahi () {
	# undefined
	builtin autoload -XUz
}
_awk () {
	# undefined
	builtin autoload -XUz
}
_axi-cache () {
	# undefined
	builtin autoload -XUz
}
_base64 () {
	# undefined
	builtin autoload -XUz
}
_basename () {
	# undefined
	builtin autoload -XUz
}
_basenc () {
	# undefined
	builtin autoload -XUz
}
_bash () {
	# undefined
	builtin autoload -XUz
}
_bash_complete () {
	local ret=1 
	local -a suf matches
	local -x COMP_POINT COMP_CWORD
	local -a COMP_WORDS COMPREPLY BASH_VERSINFO
	local -x COMP_LINE="$words" 
	local -A savejobstates savejobtexts
	(( COMP_POINT = 1 + ${#${(j. .)words[1,CURRENT-1]}} + $#QIPREFIX + $#IPREFIX + $#PREFIX ))
	(( COMP_CWORD = CURRENT - 1))
	COMP_WORDS=("${words[@]}") 
	BASH_VERSINFO=(2 05b 0 1 release) 
	savejobstates=(${(kv)jobstates}) 
	savejobtexts=(${(kv)jobtexts}) 
	[[ ${argv[${argv[(I)nospace]:-0}-1]} = -o ]] && suf=(-S '') 
	matches=(${(f)"$(compgen $@ -- ${words[CURRENT]})"}) 
	if [[ -n $matches ]]
	then
		if [[ ${argv[${argv[(I)filenames]:-0}-1]} = -o ]]
		then
			compset -P '*/' && matches=(${matches##*/}) 
			compset -S '/*' && matches=(${matches%%/*}) 
			compadd -f "${suf[@]}" -a matches && ret=0 
		else
			compadd "${suf[@]}" - "${(@)${(Q@)matches}:#*\ }" && ret=0 
			compadd -S ' ' - ${${(M)${(Q)matches}:#*\ }% } && ret=0 
		fi
	fi
	if (( ret ))
	then
		if [[ ${argv[${argv[(I)default]:-0}-1]} = -o ]]
		then
			_default "${suf[@]}" && ret=0 
		elif [[ ${argv[${argv[(I)dirnames]:-0}-1]} = -o ]]
		then
			_directories "${suf[@]}" && ret=0 
		fi
	fi
	return ret
}
_bash_completions () {
	# undefined
	builtin autoload -XUz
}
_baudrates () {
	# undefined
	builtin autoload -XUz
}
_baz () {
	# undefined
	builtin autoload -XUz
}
_bazel () {
	# undefined
	builtin autoload -XUz
}
_be_name () {
	# undefined
	builtin autoload -XUz
}
_beadm () {
	# undefined
	builtin autoload -XUz
}
_beep () {
	# undefined
	builtin autoload -XUz
}
_bibtex () {
	# undefined
	builtin autoload -XUz
}
_bind_addresses () {
	# undefined
	builtin autoload -XUz
}
_bindkey () {
	# undefined
	builtin autoload -XUz
}
_bison () {
	# undefined
	builtin autoload -XUz
}
_bittorrent () {
	# undefined
	builtin autoload -XUz
}
_bogofilter () {
	# undefined
	builtin autoload -XUz
}
_bpf_filters () {
	# undefined
	builtin autoload -XUz
}
_bpython () {
	# undefined
	builtin autoload -XUz
}
_brace_parameter () {
	# undefined
	builtin autoload -XUz
}
_brctl () {
	# undefined
	builtin autoload -XUz
}
_brew () {
	# undefined
	builtin autoload -XUz
}
_bsd_disks () {
	# undefined
	builtin autoload -XUz
}
_bsd_pkg () {
	# undefined
	builtin autoload -XUz
}
_bsdconfig () {
	# undefined
	builtin autoload -XUz
}
_bsdinstall () {
	# undefined
	builtin autoload -XUz
}
_btrfs () {
	# undefined
	builtin autoload -XUz
}
_bts () {
	# undefined
	builtin autoload -XUz
}
_bug () {
	# undefined
	builtin autoload -XUz
}
_builtin () {
	# undefined
	builtin autoload -XUz
}
_bun () {
	# undefined
	builtin autoload -XUz
}
_bzip2 () {
	# undefined
	builtin autoload -XUz
}
_bzr () {
	# undefined
	builtin autoload -XUz
}
_cabal () {
	# undefined
	builtin autoload -XUz
}
_cache_invalid () {
	# undefined
	builtin autoload -XUz
}
_caffeinate () {
	# undefined
	builtin autoload -XUz
}
_cal () {
	# undefined
	builtin autoload -XUz
}
_calendar () {
	# undefined
	builtin autoload -XUz
}
_call_function () {
	# undefined
	builtin autoload -XUz
}
_call_program () {
	local -xi COLUMNS=999 
	local curcontext="${curcontext}" tmp err_fd=-1 clocale='_comp_locale;' 
	local -a prefix
	if [[ "$1" = -p ]]
	then
		shift
		if (( $#_comp_priv_prefix ))
		then
			curcontext="${curcontext%:*}/${${(@M)_comp_priv_prefix:#^*[^\\]=*}[1]}:" 
			zstyle -t ":completion:${curcontext}:${1}" gain-privileges && prefix=($_comp_priv_prefix) 
		fi
	elif [[ "$1" = -l ]]
	then
		shift
		clocale='' 
	fi
	if (( ${debug_fd:--1} > 2 )) || [[ ! -t 2 ]]
	then
		exec {err_fd}>&2
	else
		exec {err_fd}> /dev/null
	fi
	{
		if zstyle -s ":completion:${curcontext}:${1}" command tmp
		then
			if [[ "$tmp" = -* ]]
			then
				eval $clocale "$tmp[2,-1]" "$argv[2,-1]"
			else
				eval $clocale $prefix "$tmp"
			fi
		else
			eval $clocale $prefix "$argv[2,-1]"
		fi 2>&$err_fd
	} always {
		exec {err_fd}>&-
	}
}
_canonical_paths () {
	# undefined
	builtin autoload -XUz
}
_capabilities () {
	# undefined
	builtin autoload -XUz
}
_cat () {
	# undefined
	builtin autoload -XUz
}
_ccal () {
	# undefined
	builtin autoload -XUz
}
_cd () {
	# undefined
	builtin autoload -XUz
}
_cdbs-edit-patch () {
	# undefined
	builtin autoload -XUz
}
_cdcd () {
	# undefined
	builtin autoload -XUz
}
_cdr () {
	# undefined
	builtin autoload -XUz
}
_cdrdao () {
	# undefined
	builtin autoload -XUz
}
_cdrecord () {
	# undefined
	builtin autoload -XUz
}
_chattr () {
	# undefined
	builtin autoload -XUz
}
_chcon () {
	# undefined
	builtin autoload -XUz
}
_chflags () {
	# undefined
	builtin autoload -XUz
}
_chkconfig () {
	# undefined
	builtin autoload -XUz
}
_chmod () {
	# undefined
	builtin autoload -XUz
}
_choom () {
	# undefined
	builtin autoload -XUz
}
_chown () {
	# undefined
	builtin autoload -XUz
}
_chroot () {
	# undefined
	builtin autoload -XUz
}
_chrt () {
	# undefined
	builtin autoload -XUz
}
_chsh () {
	# undefined
	builtin autoload -XUz
}
_cksum () {
	# undefined
	builtin autoload -XUz
}
_clay () {
	# undefined
	builtin autoload -XUz
}
_cmdambivalent () {
	# undefined
	builtin autoload -XUz
}
_cmdstring () {
	# undefined
	builtin autoload -XUz
}
_cmp () {
	# undefined
	builtin autoload -XUz
}
_code () {
	# undefined
	builtin autoload -XUz
}
_column () {
	# undefined
	builtin autoload -XUz
}
_combination () {
	# undefined
	builtin autoload -XUz
}
_comm () {
	# undefined
	builtin autoload -XUz
}
_command () {
	# undefined
	builtin autoload -XUz
}
_command_names () {
	# undefined
	builtin autoload -XUz
}
_comp_locale () {
	# undefined
	builtin autoload -XUz
}
_compadd () {
	# undefined
	builtin autoload -XUz
}
_compdef () {
	# undefined
	builtin autoload -XUz
}
_complete () {
	# undefined
	builtin autoload -XUz
}
_complete_debug () {
	# undefined
	builtin autoload -XUz
}
_complete_help () {
	# undefined
	builtin autoload -XUz
}
_complete_help_generic () {
	# undefined
	builtin autoload -XUz
}
_complete_tag () {
	# undefined
	builtin autoload -XUz
}
_completers () {
	# undefined
	builtin autoload -XUz
}
_composer () {
	# undefined
	builtin autoload -XUz
}
_compress () {
	# undefined
	builtin autoload -XUz
}
_condition () {
	# undefined
	builtin autoload -XUz
}
_configure () {
	# undefined
	builtin autoload -XUz
}
_coreadm () {
	# undefined
	builtin autoload -XUz
}
_correct () {
	# undefined
	builtin autoload -XUz
}
_correct_filename () {
	# undefined
	builtin autoload -XUz
}
_correct_word () {
	# undefined
	builtin autoload -XUz
}
_cowsay () {
	# undefined
	builtin autoload -XUz
}
_cp () {
	# undefined
	builtin autoload -XUz
}
_cpio () {
	# undefined
	builtin autoload -XUz
}
_cplay () {
	# undefined
	builtin autoload -XUz
}
_cpupower () {
	# undefined
	builtin autoload -XUz
}
_crontab () {
	# undefined
	builtin autoload -XUz
}
_cryptsetup () {
	# undefined
	builtin autoload -XUz
}
_cscope () {
	# undefined
	builtin autoload -XUz
}
_csplit () {
	# undefined
	builtin autoload -XUz
}
_cssh () {
	# undefined
	builtin autoload -XUz
}
_csup () {
	# undefined
	builtin autoload -XUz
}
_ctags () {
	# undefined
	builtin autoload -XUz
}
_ctags_tags () {
	# undefined
	builtin autoload -XUz
}
_cu () {
	# undefined
	builtin autoload -XUz
}
_curl () {
	# undefined
	builtin autoload -XUz
}
_cut () {
	# undefined
	builtin autoload -XUz
}
_cvs () {
	# undefined
	builtin autoload -XUz
}
_cvsup () {
	# undefined
	builtin autoload -XUz
}
_cygcheck () {
	# undefined
	builtin autoload -XUz
}
_cygpath () {
	# undefined
	builtin autoload -XUz
}
_cygrunsrv () {
	# undefined
	builtin autoload -XUz
}
_cygserver () {
	# undefined
	builtin autoload -XUz
}
_cygstart () {
	# undefined
	builtin autoload -XUz
}
_dak () {
	# undefined
	builtin autoload -XUz
}
_darcs () {
	# undefined
	builtin autoload -XUz
}
_date () {
	# undefined
	builtin autoload -XUz
}
_date_formats () {
	# undefined
	builtin autoload -XUz
}
_dates () {
	# undefined
	builtin autoload -XUz
}
_dbus () {
	# undefined
	builtin autoload -XUz
}
_dchroot () {
	# undefined
	builtin autoload -XUz
}
_dchroot-dsa () {
	# undefined
	builtin autoload -XUz
}
_dconf () {
	# undefined
	builtin autoload -XUz
}
_dcop () {
	# undefined
	builtin autoload -XUz
}
_dcut () {
	# undefined
	builtin autoload -XUz
}
_dd () {
	# undefined
	builtin autoload -XUz
}
_deb_architectures () {
	# undefined
	builtin autoload -XUz
}
_deb_codenames () {
	# undefined
	builtin autoload -XUz
}
_deb_files () {
	# undefined
	builtin autoload -XUz
}
_deb_packages () {
	# undefined
	builtin autoload -XUz
}
_debbugs_bugnumber () {
	# undefined
	builtin autoload -XUz
}
_debchange () {
	# undefined
	builtin autoload -XUz
}
_debcheckout () {
	# undefined
	builtin autoload -XUz
}
_debdiff () {
	# undefined
	builtin autoload -XUz
}
_debfoster () {
	# undefined
	builtin autoload -XUz
}
_deborphan () {
	# undefined
	builtin autoload -XUz
}
_debsign () {
	# undefined
	builtin autoload -XUz
}
_debsnap () {
	# undefined
	builtin autoload -XUz
}
_debuild () {
	# undefined
	builtin autoload -XUz
}
_default () {
	# undefined
	builtin autoload -XUz
}
_defaults () {
	# undefined
	builtin autoload -XUz
}
_defer_async_git_register () {
	case "${PS1}:${PS2}:${PS3}:${PS4}:${RPROMPT-}:${RPS1-}:${RPS2-}:${RPS3-}:${RPS4-}" in
		(*(\$\(git_prompt_info\)|\`git_prompt_info\`)*) _omz_register_handler _omz_git_prompt_info ;;
	esac
	case "${PS1}:${PS2}:${PS3}:${PS4}:${RPROMPT-}:${RPS1-}:${RPS2-}:${RPS3-}:${RPS4-}" in
		(*(\$\(git_prompt_status\)|\`git_prompt_status\`)*) _omz_register_handler _omz_git_prompt_status ;;
	esac
	add-zsh-hook -d precmd _defer_async_git_register
	unset -f _defer_async_git_register
}
_delimiters () {
	# undefined
	builtin autoload -XUz
}
_describe () {
	# undefined
	builtin autoload -XUz
}
_description () {
	# undefined
	builtin autoload -XUz
}
_devtodo () {
	# undefined
	builtin autoload -XUz
}
_df () {
	# undefined
	builtin autoload -XUz
}
_dhclient () {
	# undefined
	builtin autoload -XUz
}
_dhcpinfo () {
	# undefined
	builtin autoload -XUz
}
_dict () {
	# undefined
	builtin autoload -XUz
}
_dict_words () {
	# undefined
	builtin autoload -XUz
}
_diff () {
	# undefined
	builtin autoload -XUz
}
_diff3 () {
	# undefined
	builtin autoload -XUz
}
_diff_options () {
	# undefined
	builtin autoload -XUz
}
_diffstat () {
	# undefined
	builtin autoload -XUz
}
_dig () {
	# undefined
	builtin autoload -XUz
}
_dir_list () {
	# undefined
	builtin autoload -XUz
}
_directories () {
	# undefined
	builtin autoload -XUz
}
_directory_stack () {
	# undefined
	builtin autoload -XUz
}
_dirs () {
	# undefined
	builtin autoload -XUz
}
_disable () {
	# undefined
	builtin autoload -XUz
}
_dispatch () {
	# undefined
	builtin autoload -XUz
}
_django () {
	# undefined
	builtin autoload -XUz
}
_dkms () {
	# undefined
	builtin autoload -XUz
}
_dladm () {
	# undefined
	builtin autoload -XUz
}
_dlocate () {
	# undefined
	builtin autoload -XUz
}
_dmesg () {
	# undefined
	builtin autoload -XUz
}
_dmidecode () {
	# undefined
	builtin autoload -XUz
}
_dnf () {
	# undefined
	builtin autoload -XUz
}
_dns_types () {
	# undefined
	builtin autoload -XUz
}
_doas () {
	# undefined
	builtin autoload -XUz
}
_domains () {
	# undefined
	builtin autoload -XUz
}
_dos2unix () {
	# undefined
	builtin autoload -XUz
}
_dpatch-edit-patch () {
	# undefined
	builtin autoload -XUz
}
_dpkg () {
	# undefined
	builtin autoload -XUz
}
_dpkg-buildpackage () {
	# undefined
	builtin autoload -XUz
}
_dpkg-cross () {
	# undefined
	builtin autoload -XUz
}
_dpkg-repack () {
	# undefined
	builtin autoload -XUz
}
_dpkg_source () {
	# undefined
	builtin autoload -XUz
}
_dput () {
	# undefined
	builtin autoload -XUz
}
_drill () {
	# undefined
	builtin autoload -XUz
}
_dropbox () {
	# undefined
	builtin autoload -XUz
}
_dscverify () {
	# undefined
	builtin autoload -XUz
}
_dsh () {
	# undefined
	builtin autoload -XUz
}
_dtrace () {
	# undefined
	builtin autoload -XUz
}
_dtruss () {
	# undefined
	builtin autoload -XUz
}
_du () {
	# undefined
	builtin autoload -XUz
}
_dumpadm () {
	# undefined
	builtin autoload -XUz
}
_dumper () {
	# undefined
	builtin autoload -XUz
}
_dupload () {
	# undefined
	builtin autoload -XUz
}
_dvi () {
	# undefined
	builtin autoload -XUz
}
_dynamic_directory_name () {
	# undefined
	builtin autoload -XUz
}
_e2label () {
	# undefined
	builtin autoload -XUz
}
_ecasound () {
	# undefined
	builtin autoload -XUz
}
_echotc () {
	# undefined
	builtin autoload -XUz
}
_echoti () {
	# undefined
	builtin autoload -XUz
}
_ed () {
	# undefined
	builtin autoload -XUz
}
_elfdump () {
	# undefined
	builtin autoload -XUz
}
_elinks () {
	# undefined
	builtin autoload -XUz
}
_email_addresses () {
	# undefined
	builtin autoload -XUz
}
_emulate () {
	# undefined
	builtin autoload -XUz
}
_enable () {
	# undefined
	builtin autoload -XUz
}
_enscript () {
	# undefined
	builtin autoload -XUz
}
_entr () {
	# undefined
	builtin autoload -XUz
}
_env () {
	# undefined
	builtin autoload -XUz
}
_eog () {
	# undefined
	builtin autoload -XUz
}
_equal () {
	# undefined
	builtin autoload -XUz
}
_espeak () {
	# undefined
	builtin autoload -XUz
}
_etags () {
	# undefined
	builtin autoload -XUz
}
_ethtool () {
	# undefined
	builtin autoload -XUz
}
_evince () {
	# undefined
	builtin autoload -XUz
}
_exec () {
	# undefined
	builtin autoload -XUz
}
_expand () {
	# undefined
	builtin autoload -XUz
}
_expand_alias () {
	# undefined
	builtin autoload -XUz
}
_expand_word () {
	# undefined
	builtin autoload -XUz
}
_extensions () {
	# undefined
	builtin autoload -XUz
}
_external_pwds () {
	# undefined
	builtin autoload -XUz
}
_fakeroot () {
	# undefined
	builtin autoload -XUz
}
_fbsd_architectures () {
	# undefined
	builtin autoload -XUz
}
_fbsd_device_types () {
	# undefined
	builtin autoload -XUz
}
_fc () {
	# undefined
	builtin autoload -XUz
}
_feh () {
	# undefined
	builtin autoload -XUz
}
_fetch () {
	# undefined
	builtin autoload -XUz
}
_fetchmail () {
	# undefined
	builtin autoload -XUz
}
_ffmpeg () {
	# undefined
	builtin autoload -XUz
}
_figlet () {
	# undefined
	builtin autoload -XUz
}
_file_descriptors () {
	# undefined
	builtin autoload -XUz
}
_file_flags () {
	# undefined
	builtin autoload -XUz
}
_file_modes () {
	# undefined
	builtin autoload -XUz
}
_file_systems () {
	# undefined
	builtin autoload -XUz
}
_files () {
	# undefined
	builtin autoload -XUz
}
_find () {
	# undefined
	builtin autoload -XUz
}
_find_net_interfaces () {
	# undefined
	builtin autoload -XUz
}
_findmnt () {
	# undefined
	builtin autoload -XUz
}
_finger () {
	# undefined
	builtin autoload -XUz
}
_fink () {
	# undefined
	builtin autoload -XUz
}
_first () {
	# undefined
	builtin autoload -XUz
}
_flac () {
	# undefined
	builtin autoload -XUz
}
_flex () {
	# undefined
	builtin autoload -XUz
}
_floppy () {
	# undefined
	builtin autoload -XUz
}
_flowadm () {
	# undefined
	builtin autoload -XUz
}
_fmadm () {
	# undefined
	builtin autoload -XUz
}
_fmt () {
	# undefined
	builtin autoload -XUz
}
_fold () {
	# undefined
	builtin autoload -XUz
}
_fortune () {
	# undefined
	builtin autoload -XUz
}
_free () {
	# undefined
	builtin autoload -XUz
}
_freebsd-update () {
	# undefined
	builtin autoload -XUz
}
_fs_usage () {
	# undefined
	builtin autoload -XUz
}
_fsh () {
	# undefined
	builtin autoload -XUz
}
_fstat () {
	# undefined
	builtin autoload -XUz
}
_functions () {
	# undefined
	builtin autoload -XUz
}
_fuse_arguments () {
	# undefined
	builtin autoload -XUz
}
_fuse_values () {
	# undefined
	builtin autoload -XUz
}
_fuser () {
	# undefined
	builtin autoload -XUz
}
_fusermount () {
	# undefined
	builtin autoload -XUz
}
_fw_update () {
	# undefined
	builtin autoload -XUz
}
_gcc () {
	# undefined
	builtin autoload -XUz
}
_gcore () {
	# undefined
	builtin autoload -XUz
}
_gdb () {
	# undefined
	builtin autoload -XUz
}
_geany () {
	# undefined
	builtin autoload -XUz
}
_gem () {
	# undefined
	builtin autoload -XUz
}
_generic () {
	# undefined
	builtin autoload -XUz
}
_genisoimage () {
	# undefined
	builtin autoload -XUz
}
_getclip () {
	# undefined
	builtin autoload -XUz
}
_getconf () {
	# undefined
	builtin autoload -XUz
}
_getent () {
	# undefined
	builtin autoload -XUz
}
_getfacl () {
	# undefined
	builtin autoload -XUz
}
_getmail () {
	# undefined
	builtin autoload -XUz
}
_getopt () {
	# undefined
	builtin autoload -XUz
}
_ghostscript () {
	# undefined
	builtin autoload -XUz
}
_git () {
	# undefined
	builtin autoload -XUz
}
_git-buildpackage () {
	# undefined
	builtin autoload -XUz
}
_git_log_prettily () {
	if ! [ -z $1 ]
	then
		git log --pretty=$1
	fi
}
_global () {
	# undefined
	builtin autoload -XUz
}
_global_tags () {
	# undefined
	builtin autoload -XUz
}
_globflags () {
	# undefined
	builtin autoload -XUz
}
_globqual_delims () {
	# undefined
	builtin autoload -XUz
}
_globquals () {
	# undefined
	builtin autoload -XUz
}
_gnome-gv () {
	# undefined
	builtin autoload -XUz
}
_gnu_generic () {
	# undefined
	builtin autoload -XUz
}
_gnupod () {
	# undefined
	builtin autoload -XUz
}
_gnutls () {
	# undefined
	builtin autoload -XUz
}
_go () {
	# undefined
	builtin autoload -XUz
}
_gpasswd () {
	# undefined
	builtin autoload -XUz
}
_gpg () {
	# undefined
	builtin autoload -XUz
}
_gphoto2 () {
	# undefined
	builtin autoload -XUz
}
_gprof () {
	# undefined
	builtin autoload -XUz
}
_gqview () {
	# undefined
	builtin autoload -XUz
}
_gradle () {
	# undefined
	builtin autoload -XUz
}
_graphicsmagick () {
	# undefined
	builtin autoload -XUz
}
_grep () {
	# undefined
	builtin autoload -XUz
}
_grep-excuses () {
	# undefined
	builtin autoload -XUz
}
_groff () {
	# undefined
	builtin autoload -XUz
}
_groups () {
	# undefined
	builtin autoload -XUz
}
_growisofs () {
	# undefined
	builtin autoload -XUz
}
_gsettings () {
	# undefined
	builtin autoload -XUz
}
_gstat () {
	# undefined
	builtin autoload -XUz
}
_guard () {
	# undefined
	builtin autoload -XUz
}
_guilt () {
	# undefined
	builtin autoload -XUz
}
_gv () {
	# undefined
	builtin autoload -XUz
}
_gzip () {
	# undefined
	builtin autoload -XUz
}
_hash () {
	# undefined
	builtin autoload -XUz
}
_have_glob_qual () {
	# undefined
	builtin autoload -XUz
}
_hdiutil () {
	# undefined
	builtin autoload -XUz
}
_head () {
	# undefined
	builtin autoload -XUz
}
_hexdump () {
	# undefined
	builtin autoload -XUz
}
_history () {
	# undefined
	builtin autoload -XUz
}
_history_complete_word () {
	# undefined
	builtin autoload -XUz
}
_history_modifiers () {
	# undefined
	builtin autoload -XUz
}
_host () {
	# undefined
	builtin autoload -XUz
}
_hostname () {
	# undefined
	builtin autoload -XUz
}
_hosts () {
	# undefined
	builtin autoload -XUz
}
_htop () {
	# undefined
	builtin autoload -XUz
}
_hwinfo () {
	# undefined
	builtin autoload -XUz
}
_iconv () {
	# undefined
	builtin autoload -XUz
}
_iconvconfig () {
	# undefined
	builtin autoload -XUz
}
_id () {
	# undefined
	builtin autoload -XUz
}
_ifconfig () {
	# undefined
	builtin autoload -XUz
}
_iftop () {
	# undefined
	builtin autoload -XUz
}
_ignored () {
	# undefined
	builtin autoload -XUz
}
_imagemagick () {
	# undefined
	builtin autoload -XUz
}
_in_vared () {
	# undefined
	builtin autoload -XUz
}
_inetadm () {
	# undefined
	builtin autoload -XUz
}
_init_d () {
	# undefined
	builtin autoload -XUz
}
_initctl () {
	# undefined
	builtin autoload -XUz
}
_install () {
	# undefined
	builtin autoload -XUz
}
_invoke-rc.d () {
	# undefined
	builtin autoload -XUz
}
_ionice () {
	# undefined
	builtin autoload -XUz
}
_iostat () {
	# undefined
	builtin autoload -XUz
}
_ip () {
	# undefined
	builtin autoload -XUz
}
_ipadm () {
	# undefined
	builtin autoload -XUz
}
_ipfw () {
	# undefined
	builtin autoload -XUz
}
_ipsec () {
	# undefined
	builtin autoload -XUz
}
_ipset () {
	# undefined
	builtin autoload -XUz
}
_iptables () {
	# undefined
	builtin autoload -XUz
}
_irssi () {
	# undefined
	builtin autoload -XUz
}
_ispell () {
	# undefined
	builtin autoload -XUz
}
_iwconfig () {
	# undefined
	builtin autoload -XUz
}
_jail () {
	# undefined
	builtin autoload -XUz
}
_jails () {
	# undefined
	builtin autoload -XUz
}
_java () {
	# undefined
	builtin autoload -XUz
}
_java_class () {
	# undefined
	builtin autoload -XUz
}
_jexec () {
	# undefined
	builtin autoload -XUz
}
_jls () {
	# undefined
	builtin autoload -XUz
}
_jobs () {
	# undefined
	builtin autoload -XUz
}
_jobs_bg () {
	# undefined
	builtin autoload -XUz
}
_jobs_builtin () {
	# undefined
	builtin autoload -XUz
}
_jobs_fg () {
	# undefined
	builtin autoload -XUz
}
_joe () {
	# undefined
	builtin autoload -XUz
}
_join () {
	# undefined
	builtin autoload -XUz
}
_jot () {
	# undefined
	builtin autoload -XUz
}
_jq () {
	# undefined
	builtin autoload -XUz
}
_kdeconnect () {
	# undefined
	builtin autoload -XUz
}
_kdump () {
	# undefined
	builtin autoload -XUz
}
_kfmclient () {
	# undefined
	builtin autoload -XUz
}
_kill () {
	# undefined
	builtin autoload -XUz
}
_killall () {
	# undefined
	builtin autoload -XUz
}
_kld () {
	# undefined
	builtin autoload -XUz
}
_knock () {
	# undefined
	builtin autoload -XUz
}
_kpartx () {
	# undefined
	builtin autoload -XUz
}
_ktrace () {
	# undefined
	builtin autoload -XUz
}
_ktrace_points () {
	# undefined
	builtin autoload -XUz
}
_kvno () {
	# undefined
	builtin autoload -XUz
}
_last () {
	# undefined
	builtin autoload -XUz
}
_ld_debug () {
	# undefined
	builtin autoload -XUz
}
_ldap () {
	# undefined
	builtin autoload -XUz
}
_ldconfig () {
	# undefined
	builtin autoload -XUz
}
_ldd () {
	# undefined
	builtin autoload -XUz
}
_less () {
	# undefined
	builtin autoload -XUz
}
_lha () {
	# undefined
	builtin autoload -XUz
}
_libvirt () {
	# undefined
	builtin autoload -XUz
}
_lighttpd () {
	# undefined
	builtin autoload -XUz
}
_limit () {
	# undefined
	builtin autoload -XUz
}
_limits () {
	# undefined
	builtin autoload -XUz
}
_links () {
	# undefined
	builtin autoload -XUz
}
_lintian () {
	# undefined
	builtin autoload -XUz
}
_list () {
	# undefined
	builtin autoload -XUz
}
_list_files () {
	# undefined
	builtin autoload -XUz
}
_lldb () {
	# undefined
	builtin autoload -XUz
}
_ln () {
	# undefined
	builtin autoload -XUz
}
_loadkeys () {
	# undefined
	builtin autoload -XUz
}
_locale () {
	# undefined
	builtin autoload -XUz
}
_localedef () {
	# undefined
	builtin autoload -XUz
}
_locales () {
	# undefined
	builtin autoload -XUz
}
_locate () {
	# undefined
	builtin autoload -XUz
}
_logger () {
	# undefined
	builtin autoload -XUz
}
_logical_volumes () {
	# undefined
	builtin autoload -XUz
}
_login_classes () {
	# undefined
	builtin autoload -XUz
}
_look () {
	# undefined
	builtin autoload -XUz
}
_losetup () {
	# undefined
	builtin autoload -XUz
}
_lp () {
	# undefined
	builtin autoload -XUz
}
_ls () {
	# undefined
	builtin autoload -XUz
}
_lsattr () {
	# undefined
	builtin autoload -XUz
}
_lsblk () {
	# undefined
	builtin autoload -XUz
}
_lscfg () {
	# undefined
	builtin autoload -XUz
}
_lsdev () {
	# undefined
	builtin autoload -XUz
}
_lslv () {
	# undefined
	builtin autoload -XUz
}
_lsns () {
	# undefined
	builtin autoload -XUz
}
_lsof () {
	# undefined
	builtin autoload -XUz
}
_lspv () {
	# undefined
	builtin autoload -XUz
}
_lsusb () {
	# undefined
	builtin autoload -XUz
}
_lsvg () {
	# undefined
	builtin autoload -XUz
}
_ltrace () {
	# undefined
	builtin autoload -XUz
}
_lua () {
	# undefined
	builtin autoload -XUz
}
_luarocks () {
	# undefined
	builtin autoload -XUz
}
_lynx () {
	# undefined
	builtin autoload -XUz
}
_lz4 () {
	# undefined
	builtin autoload -XUz
}
_lzop () {
	# undefined
	builtin autoload -XUz
}
_mac_applications () {
	# undefined
	builtin autoload -XUz
}
_mac_files_for_application () {
	# undefined
	builtin autoload -XUz
}
_madison () {
	# undefined
	builtin autoload -XUz
}
_mail () {
	# undefined
	builtin autoload -XUz
}
_mailboxes () {
	# undefined
	builtin autoload -XUz
}
_main_complete () {
	# undefined
	builtin autoload -XUz
}
_make () {
	# undefined
	builtin autoload -XUz
}
_make-kpkg () {
	# undefined
	builtin autoload -XUz
}
_man () {
	# undefined
	builtin autoload -XUz
}
_mat () {
	# undefined
	builtin autoload -XUz
}
_mat2 () {
	# undefined
	builtin autoload -XUz
}
_match () {
	# undefined
	builtin autoload -XUz
}
_math () {
	# undefined
	builtin autoload -XUz
}
_math_params () {
	# undefined
	builtin autoload -XUz
}
_matlab () {
	# undefined
	builtin autoload -XUz
}
_md5sum () {
	# undefined
	builtin autoload -XUz
}
_mdadm () {
	# undefined
	builtin autoload -XUz
}
_mdfind () {
	# undefined
	builtin autoload -XUz
}
_mdls () {
	# undefined
	builtin autoload -XUz
}
_mdutil () {
	# undefined
	builtin autoload -XUz
}
_members () {
	# undefined
	builtin autoload -XUz
}
_mencal () {
	# undefined
	builtin autoload -XUz
}
_menu () {
	# undefined
	builtin autoload -XUz
}
_mere () {
	# undefined
	builtin autoload -XUz
}
_mergechanges () {
	# undefined
	builtin autoload -XUz
}
_message () {
	# undefined
	builtin autoload -XUz
}
_mh () {
	# undefined
	builtin autoload -XUz
}
_mii-tool () {
	# undefined
	builtin autoload -XUz
}
_mime_types () {
	# undefined
	builtin autoload -XUz
}
_mixerctl () {
	# undefined
	builtin autoload -XUz
}
_mkdir () {
	# undefined
	builtin autoload -XUz
}
_mkfifo () {
	# undefined
	builtin autoload -XUz
}
_mknod () {
	# undefined
	builtin autoload -XUz
}
_mkshortcut () {
	# undefined
	builtin autoload -XUz
}
_mktemp () {
	# undefined
	builtin autoload -XUz
}
_mkzsh () {
	# undefined
	builtin autoload -XUz
}
_module () {
	# undefined
	builtin autoload -XUz
}
_module-assistant () {
	# undefined
	builtin autoload -XUz
}
_module_math_func () {
	# undefined
	builtin autoload -XUz
}
_modutils () {
	# undefined
	builtin autoload -XUz
}
_mondo () {
	# undefined
	builtin autoload -XUz
}
_monotone () {
	# undefined
	builtin autoload -XUz
}
_moosic () {
	# undefined
	builtin autoload -XUz
}
_mosh () {
	# undefined
	builtin autoload -XUz
}
_most_recent_file () {
	# undefined
	builtin autoload -XUz
}
_mount () {
	# undefined
	builtin autoload -XUz
}
_mozilla () {
	# undefined
	builtin autoload -XUz
}
_mpc () {
	# undefined
	builtin autoload -XUz
}
_mplayer () {
	# undefined
	builtin autoload -XUz
}
_mt () {
	# undefined
	builtin autoload -XUz
}
_mtools () {
	# undefined
	builtin autoload -XUz
}
_mtr () {
	# undefined
	builtin autoload -XUz
}
_multi_parts () {
	# undefined
	builtin autoload -XUz
}
_mupdf () {
	# undefined
	builtin autoload -XUz
}
_mutt () {
	# undefined
	builtin autoload -XUz
}
_mv () {
	# undefined
	builtin autoload -XUz
}
_my_accounts () {
	# undefined
	builtin autoload -XUz
}
_myrepos () {
	# undefined
	builtin autoload -XUz
}
_mysql_utils () {
	# undefined
	builtin autoload -XUz
}
_mysqldiff () {
	# undefined
	builtin autoload -XUz
}
_nautilus () {
	# undefined
	builtin autoload -XUz
}
_nbsd_architectures () {
	# undefined
	builtin autoload -XUz
}
_ncftp () {
	# undefined
	builtin autoload -XUz
}
_nedit () {
	# undefined
	builtin autoload -XUz
}
_net_interfaces () {
	# undefined
	builtin autoload -XUz
}
_netcat () {
	# undefined
	builtin autoload -XUz
}
_netscape () {
	# undefined
	builtin autoload -XUz
}
_netstat () {
	# undefined
	builtin autoload -XUz
}
_networkmanager () {
	# undefined
	builtin autoload -XUz
}
_networksetup () {
	# undefined
	builtin autoload -XUz
}
_newsgroups () {
	# undefined
	builtin autoload -XUz
}
_next_label () {
	# undefined
	builtin autoload -XUz
}
_next_tags () {
	# undefined
	builtin autoload -XUz
}
_nginx () {
	# undefined
	builtin autoload -XUz
}
_ngrep () {
	# undefined
	builtin autoload -XUz
}
_nice () {
	# undefined
	builtin autoload -XUz
}
_nkf () {
	# undefined
	builtin autoload -XUz
}
_nl () {
	# undefined
	builtin autoload -XUz
}
_nm () {
	# undefined
	builtin autoload -XUz
}
_nmap () {
	# undefined
	builtin autoload -XUz
}
_normal () {
	# undefined
	builtin autoload -XUz
}
_nothing () {
	# undefined
	builtin autoload -XUz
}
_npm () {
	# undefined
	builtin autoload -XUz
}
_nsenter () {
	# undefined
	builtin autoload -XUz
}
_nslookup () {
	# undefined
	builtin autoload -XUz
}
_numbers () {
	# undefined
	builtin autoload -XUz
}
_numfmt () {
	# undefined
	builtin autoload -XUz
}
_nvram () {
	# undefined
	builtin autoload -XUz
}
_objdump () {
	# undefined
	builtin autoload -XUz
}
_object_classes () {
	# undefined
	builtin autoload -XUz
}
_object_files () {
	# undefined
	builtin autoload -XUz
}
_obsd_architectures () {
	# undefined
	builtin autoload -XUz
}
_od () {
	# undefined
	builtin autoload -XUz
}
_okular () {
	# undefined
	builtin autoload -XUz
}
_oldlist () {
	# undefined
	builtin autoload -XUz
}
_omz () {
	local -a cmds subcmds
	cmds=('changelog:Print the changelog' 'help:Usage information' 'plugin:Manage plugins' 'pr:Manage Oh My Zsh Pull Requests' 'reload:Reload the current zsh session' 'shop:Open the Oh My Zsh shop' 'theme:Manage themes' 'update:Update Oh My Zsh' 'version:Show the version') 
	if (( CURRENT == 2 ))
	then
		_describe 'command' cmds
	elif (( CURRENT == 3 ))
	then
		case "$words[2]" in
			(changelog) local -a refs
				refs=("${(@f)$(builtin cd -q "$ZSH"; command git for-each-ref --format="%(refname:short):%(subject)" refs/heads refs/tags)}") 
				_describe 'command' refs ;;
			(plugin) subcmds=('disable:Disable plugin(s)' 'enable:Enable plugin(s)' 'info:Get plugin information' 'list:List plugins' 'load:Load plugin(s)') 
				_describe 'command' subcmds ;;
			(pr) subcmds=('clean:Delete all Pull Request branches' 'test:Test a Pull Request') 
				_describe 'command' subcmds ;;
			(theme) subcmds=('list:List themes' 'set:Set a theme in your .zshrc file' 'use:Load a theme') 
				_describe 'command' subcmds ;;
		esac
	elif (( CURRENT == 4 ))
	then
		case "${words[2]}::${words[3]}" in
			(plugin::(disable|enable|load)) local -aU valid_plugins
				if [[ "${words[3]}" = disable ]]
				then
					valid_plugins=($plugins) 
				else
					valid_plugins=("$ZSH"/plugins/*/{_*,*.plugin.zsh}(-.N:h:t) "$ZSH_CUSTOM"/plugins/*/{_*,*.plugin.zsh}(-.N:h:t)) 
					[[ "${words[3]}" = enable ]] && valid_plugins=(${valid_plugins:|plugins}) 
				fi
				_describe 'plugin' valid_plugins ;;
			(plugin::info) local -aU plugins
				plugins=("$ZSH"/plugins/*/{_*,*.plugin.zsh}(-.N:h:t) "$ZSH_CUSTOM"/plugins/*/{_*,*.plugin.zsh}(-.N:h:t)) 
				_describe 'plugin' plugins ;;
			(plugin::list) local -a opts
				opts=('--enabled:List enabled plugins only') 
				_describe -o 'options' opts ;;
			(theme::(set|use)) local -aU themes
				themes=("$ZSH"/themes/*.zsh-theme(-.N:t:r) "$ZSH_CUSTOM"/**/*.zsh-theme(-.N:r:gs:"$ZSH_CUSTOM"/themes/:::gs:"$ZSH_CUSTOM"/:::)) 
				_describe 'theme' themes ;;
		esac
	elif (( CURRENT > 4 ))
	then
		case "${words[2]}::${words[3]}" in
			(plugin::(enable|disable|load)) local -aU valid_plugins
				if [[ "${words[3]}" = disable ]]
				then
					valid_plugins=($plugins) 
				else
					valid_plugins=("$ZSH"/plugins/*/{_*,*.plugin.zsh}(-.N:h:t) "$ZSH_CUSTOM"/plugins/*/{_*,*.plugin.zsh}(-.N:h:t)) 
					[[ "${words[3]}" = enable ]] && valid_plugins=(${valid_plugins:|plugins}) 
				fi
				local -a args
				args=(${words[4,$(( CURRENT - 1))]}) 
				valid_plugins=(${valid_plugins:|args}) 
				_describe 'plugin' valid_plugins ;;
		esac
	fi
	return 0
}
_omz::changelog () {
	local version=${1:-HEAD} format=${3:-"--text"} 
	if (
			builtin cd -q "$ZSH"
			! command git show-ref --verify refs/heads/$version && ! command git show-ref --verify refs/tags/$version && ! command git rev-parse --verify "${version}^{commit}"
		) &> /dev/null
	then
		cat >&2 <<EOF
Usage: ${(j: :)${(s.::.)0#_}} [version]

NOTE: <version> must be a valid branch, tag or commit.
EOF
		return 1
	fi
	ZSH="$ZSH" command zsh -f "$ZSH/tools/changelog.sh" "$version" "${2:-}" "$format"
}
_omz::confirm () {
	if [[ -n "$1" ]]
	then
		_omz::log prompt "$1" "${${functrace[1]#_}%:*}"
	fi
	read -r -k 1
	if [[ "$REPLY" != $'\n' ]]
	then
		echo
	fi
}
_omz::help () {
	cat >&2 <<EOF
Usage: omz <command> [options]

Available commands:

  help                Print this help message
  changelog           Print the changelog
  plugin <command>    Manage plugins
  pr     <command>    Manage Oh My Zsh Pull Requests
  reload              Reload the current zsh session
  shop                Open the Oh My Zsh shop
  theme  <command>    Manage themes
  update              Update Oh My Zsh
  version             Show the version

EOF
}
_omz::log () {
	setopt localoptions nopromptsubst
	local logtype=$1 
	local logname=${3:-${${functrace[1]#_}%:*}} 
	if [[ $logtype = debug && -z $_OMZ_DEBUG ]]
	then
		return
	fi
	case "$logtype" in
		(prompt) print -Pn "%S%F{blue}$logname%f%s: $2" ;;
		(debug) print -P "%F{white}$logname%f: $2" ;;
		(info) print -P "%F{green}$logname%f: $2" ;;
		(warn) print -P "%S%F{yellow}$logname%f%s: $2" ;;
		(error) print -P "%S%F{red}$logname%f%s: $2" ;;
	esac >&2
}
_omz::plugin () {
	(( $# > 0 && $+functions[$0::$1] )) || {
		cat >&2 <<EOF
Usage: ${(j: :)${(s.::.)0#_}} <command> [options]

Available commands:

  disable <plugin> Disable plugin(s)
  enable <plugin>  Enable plugin(s)
  info <plugin>    Get information of a plugin
  list [--enabled] List Oh My Zsh plugins
  load <plugin>    Load plugin(s)

EOF
		return 1
	}
	local command="$1" 
	shift
	$0::$command "$@"
}
_omz::plugin::disable () {
	if [[ -z "$1" ]]
	then
		echo "Usage: ${(j: :)${(s.::.)0#_}} <plugin> [...]" >&2
		return 1
	fi
	local -a dis_plugins
	for plugin in "$@"
	do
		if [[ ${plugins[(Ie)$plugin]} -eq 0 ]]
		then
			_omz::log warn "plugin '$plugin' is not enabled."
			continue
		fi
		dis_plugins+=("$plugin") 
	done
	if [[ ${#dis_plugins} -eq 0 ]]
	then
		return 1
	fi
	local awk_subst_plugins="  gsub(/[ \t]+(${(j:|:)dis_plugins})[ \t]+/, \" \") # with spaces before or after
  gsub(/[ \t]+(${(j:|:)dis_plugins})$/, \"\")       # with spaces before and EOL
  gsub(/^(${(j:|:)dis_plugins})[ \t]+/, \"\")       # with BOL and spaces after

  gsub(/\((${(j:|:)dis_plugins})[ \t]+/, \"(\")     # with parenthesis before and spaces after
  gsub(/[ \t]+(${(j:|:)dis_plugins})\)/, \")\")     # with spaces before or parenthesis after
  gsub(/\((${(j:|:)dis_plugins})\)/, \"()\")        # with only parentheses

  gsub(/^(${(j:|:)dis_plugins})\)/, \")\")          # with BOL and closing parenthesis
  gsub(/\((${(j:|:)dis_plugins})$/, \"(\")          # with opening parenthesis and EOL
" 
	local awk_script="
# if plugins=() is in oneline form, substitute disabled plugins and go to next line
/^[ \t]*plugins=\([^#]+\).*\$/ {
  $awk_subst_plugins
  print \$0
  next
}

# if plugins=() is in multiline form, enable multi flag and disable plugins if they're there
/^[ \t]*plugins=\(/ {
  multi=1
  $awk_subst_plugins
  print \$0
  next
}

# if multi flag is enabled and we find a valid closing parenthesis, remove plugins and disable multi flag
multi == 1 && /^[^#]*\)/ {
  multi=0
  $awk_subst_plugins
  print \$0
  next
}

multi == 1 && length(\$0) > 0 {
  $awk_subst_plugins
  if (length(\$0) > 0) print \$0
  next
}

{ print \$0 }
" 
	local zdot="${ZDOTDIR:-$HOME}" 
	local zshrc="${${:-"${zdot}/.zshrc"}:A}" 
	awk "$awk_script" "$zshrc" > "$zdot/.zshrc.new" && command cp -f "$zshrc" "$zdot/.zshrc.bck" && command mv -f "$zdot/.zshrc.new" "$zshrc"
	[[ $? -eq 0 ]] || {
		local ret=$? 
		_omz::log error "error disabling plugins."
		return $ret
	}
	if ! command zsh -n "$zdot/.zshrc"
	then
		_omz::log error "broken syntax in '"${zdot/#$HOME/\~}/.zshrc"'. Rolling back changes..."
		command mv -f "$zdot/.zshrc.bck" "$zshrc"
		return 1
	fi
	_omz::log info "plugins disabled: ${(j:, :)dis_plugins}."
	[[ ! -o interactive ]] || _omz::reload
}
_omz::plugin::enable () {
	if [[ -z "$1" ]]
	then
		echo "Usage: ${(j: :)${(s.::.)0#_}} <plugin> [...]" >&2
		return 1
	fi
	local -a add_plugins
	for plugin in "$@"
	do
		if [[ ${plugins[(Ie)$plugin]} -ne 0 ]]
		then
			_omz::log warn "plugin '$plugin' is already enabled."
			continue
		fi
		add_plugins+=("$plugin") 
	done
	if [[ ${#add_plugins} -eq 0 ]]
	then
		return 1
	fi
	local awk_script="
# if plugins=() is in oneline form, substitute ) with new plugins and go to the next line
/^[ \t]*plugins=\([^#]+\).*\$/ {
  sub(/\)/, \" $add_plugins&\")
  print \$0
  next
}

# if plugins=() is in multiline form, enable multi flag and indent by default with 2 spaces
/^[ \t]*plugins=\(/ {
  multi=1
  indent=\"  \"
  print \$0
  next
}

# if multi flag is enabled and we find a valid closing parenthesis,
# add new plugins with proper indent and disable multi flag
multi == 1 && /^[^#]*\)/ {
  multi=0
  split(\"$add_plugins\",p,\" \")
  for (i in p) {
    print indent p[i]
  }
  print \$0
  next
}

# if multi flag is enabled and we didn't find a closing parenthesis,
# get the indentation level to match when adding plugins
multi == 1 && /^[^#]*/ {
  indent=\"\"
  for (i = 1; i <= length(\$0); i++) {
    char=substr(\$0, i, 1)
    if (char == \" \" || char == \"\t\") {
      indent = indent char
    } else {
      break
    }
  }
}

{ print \$0 }
" 
	local zdot="${ZDOTDIR:-$HOME}" 
	local zshrc="${${:-"${zdot}/.zshrc"}:A}" 
	awk "$awk_script" "$zshrc" > "$zdot/.zshrc.new" && command cp -f "$zshrc" "$zdot/.zshrc.bck" && command mv -f "$zdot/.zshrc.new" "$zshrc"
	[[ $? -eq 0 ]] || {
		local ret=$? 
		_omz::log error "error enabling plugins."
		return $ret
	}
	if ! command zsh -n "$zdot/.zshrc"
	then
		_omz::log error "broken syntax in '"${zdot/#$HOME/\~}/.zshrc"'. Rolling back changes..."
		command mv -f "$zdot/.zshrc.bck" "$zshrc"
		return 1
	fi
	_omz::log info "plugins enabled: ${(j:, :)add_plugins}."
	[[ ! -o interactive ]] || _omz::reload
}
_omz::plugin::info () {
	if [[ -z "$1" ]]
	then
		echo "Usage: ${(j: :)${(s.::.)0#_}} <plugin>" >&2
		return 1
	fi
	local readme
	for readme in "$ZSH_CUSTOM/plugins/$1/README.md" "$ZSH/plugins/$1/README.md"
	do
		if [[ -f "$readme" ]]
		then
			if [[ ! -t 1 ]]
			then
				cat "$readme"
				return $?
			fi
			case 1 in
				(${+commands[glow]}) glow -p "$readme" ;;
				(${+commands[bat]}) bat -l md --style plain "$readme" ;;
				(${+commands[less]}) less "$readme" ;;
				(*) cat "$readme" ;;
			esac
			return $?
		fi
	done
	if [[ -d "$ZSH_CUSTOM/plugins/$1" || -d "$ZSH/plugins/$1" ]]
	then
		_omz::log error "the '$1' plugin doesn't have a README file"
	else
		_omz::log error "'$1' plugin not found"
	fi
	return 1
}
_omz::plugin::list () {
	local -a custom_plugins builtin_plugins
	if [[ "$1" == "--enabled" ]]
	then
		local plugin
		for plugin in "${plugins[@]}"
		do
			if [[ -d "${ZSH_CUSTOM}/plugins/${plugin}" ]]
			then
				custom_plugins+=("${plugin}") 
			elif [[ -d "${ZSH}/plugins/${plugin}" ]]
			then
				builtin_plugins+=("${plugin}") 
			fi
		done
	else
		custom_plugins=("$ZSH_CUSTOM"/plugins/*(-/N:t)) 
		builtin_plugins=("$ZSH"/plugins/*(-/N:t)) 
	fi
	if [[ ! -t 1 ]]
	then
		print -l ${(q-)custom_plugins} ${(q-)builtin_plugins}
		return
	fi
	if (( ${#custom_plugins} ))
	then
		print -P "%U%BCustom plugins%b%u:"
		print -lac ${(q-)custom_plugins}
	fi
	if (( ${#builtin_plugins} ))
	then
		(( ${#custom_plugins} )) && echo
		print -P "%U%BBuilt-in plugins%b%u:"
		print -lac ${(q-)builtin_plugins}
	fi
}
_omz::plugin::load () {
	if [[ -z "$1" ]]
	then
		echo "Usage: ${(j: :)${(s.::.)0#_}} <plugin> [...]" >&2
		return 1
	fi
	local plugin base has_completion=0 
	for plugin in "$@"
	do
		if [[ -d "$ZSH_CUSTOM/plugins/$plugin" ]]
		then
			base="$ZSH_CUSTOM/plugins/$plugin" 
		elif [[ -d "$ZSH/plugins/$plugin" ]]
		then
			base="$ZSH/plugins/$plugin" 
		else
			_omz::log warn "plugin '$plugin' not found"
			continue
		fi
		if [[ ! -f "$base/_$plugin" && ! -f "$base/$plugin.plugin.zsh" ]]
		then
			_omz::log warn "'$plugin' is not a valid plugin"
			continue
		elif (( ! ${fpath[(Ie)$base]} ))
		then
			fpath=("$base" $fpath) 
		fi
		local -a comp_files
		comp_files=($base/_*(N)) 
		has_completion=$(( $#comp_files > 0 )) 
		if [[ -f "$base/$plugin.plugin.zsh" ]]
		then
			source "$base/$plugin.plugin.zsh"
		fi
	done
	if (( has_completion ))
	then
		compinit -D -d "$_comp_dumpfile"
	fi
}
_omz::pr () {
	(( $# > 0 && $+functions[$0::$1] )) || {
		cat >&2 <<EOF
Usage: ${(j: :)${(s.::.)0#_}} <command> [options]

Available commands:

  clean                       Delete all PR branches (ohmyzsh/pull-*)
  test <PR_number_or_URL>     Fetch PR #NUMBER and rebase against master

EOF
		return 1
	}
	local command="$1" 
	shift
	$0::$command "$@"
}
_omz::pr::clean () {
	(
		set -e
		builtin cd -q "$ZSH"
		local fmt branches
		fmt="%(color:bold blue)%(align:18,right)%(refname:short)%(end)%(color:reset) %(color:dim bold red)%(objectname:short)%(color:reset) %(color:yellow)%(contents:subject)" 
		branches="$(command git for-each-ref --sort=-committerdate --color --format="$fmt" "refs/heads/ohmyzsh/pull-*")" 
		if [[ -z "$branches" ]]
		then
			_omz::log info "there are no Pull Request branches to remove."
			return
		fi
		echo "$branches\n"
		_omz::confirm "do you want remove these Pull Request branches? [Y/n] "
		[[ "$REPLY" != [yY$'\n'] ]] && return
		_omz::log info "removing all Oh My Zsh Pull Request branches..."
		command git branch --list 'ohmyzsh/pull-*' | while read branch
		do
			command git branch -D "$branch"
		done
	)
}
_omz::pr::test () {
	if [[ "$1" = https://* ]]
	then
		1="${1:t}" 
	fi
	if ! [[ -n "$1" && "$1" =~ ^[[:digit:]]+$ ]]
	then
		echo "Usage: ${(j: :)${(s.::.)0#_}} <PR_NUMBER_or_URL>" >&2
		return 1
	fi
	local branch
	branch=$(builtin cd -q "$ZSH"; git symbolic-ref --short HEAD)  || {
		_omz::log error "error when getting the current git branch. Aborting..."
		return 1
	}
	(
		set -e
		builtin cd -q "$ZSH"
		command git remote -v | while read remote url _
		do
			case "$url" in
				(https://github.com/ohmyzsh/ohmyzsh(|.git)) found=1 
					break ;;
				(git@github.com:ohmyzsh/ohmyzsh(|.git)) found=1 
					break ;;
			esac
		done
		(( $found )) || {
			_omz::log error "could not find the ohmyzsh git remote. Aborting..."
			return 1
		}
		_omz::log info "checking if PR #$1 has the 'testers needed' label..."
		local pr_json label label_id="MDU6TGFiZWw4NzY1NTkwNA==" 
		pr_json=$(
      curl -fsSL \
        -H "Accept: application/vnd.github+json" \
        -H "X-GitHub-Api-Version: 2022-11-28" \
        "https://api.github.com/repos/ohmyzsh/ohmyzsh/pulls/$1"
    ) 
		if [[ $? -gt 0 || -z "$pr_json" ]]
		then
			_omz::log error "error when trying to fetch PR #$1 from GitHub."
			return 1
		fi
		if (( $+commands[jq] ))
		then
			label="$(command jq ".labels.[] | select(.node_id == \"$label_id\")" <<< "$pr_json")" 
		else
			label="$(command grep "\"$label_id\"" <<< "$pr_json" 2>/dev/null)" 
		fi
		if [[ -z "$label" ]]
		then
			_omz::log warn "PR #$1 does not have the 'testers needed' label. This means that the PR"
			_omz::log warn "has not been reviewed by a maintainer and may contain malicious code."
			_omz::log prompt "Do you want to continue testing it? [yes/N] "
			builtin read -r
			if [[ "${REPLY:l}" != yes ]]
			then
				_omz::log error "PR test canceled. Please ask a maintainer to review and label the PR."
				return 1
			else
				_omz::log warn "Continuing to check out and test PR #$1. Be careful!"
			fi
		fi
		_omz::log info "fetching PR #$1 to ohmyzsh/pull-$1..."
		command git fetch -f "$remote" refs/pull/$1/head:ohmyzsh/pull-$1 || {
			_omz::log error "error when trying to fetch PR #$1."
			return 1
		}
		_omz::log info "rebasing PR #$1..."
		local ret gpgsign
		{
			gpgsign=$(command git config --local commit.gpgsign 2>/dev/null)  || ret=$? 
			[[ $ret -ne 129 ]] || gpgsign=$(command git config commit.gpgsign 2>/dev/null) 
			command git config commit.gpgsign false
			command git rebase master ohmyzsh/pull-$1 || {
				command git rebase --abort &> /dev/null
				_omz::log warn "could not rebase PR #$1 on top of master."
				_omz::log warn "you might not see the latest stable changes."
				_omz::log info "run \`zsh\` to test the changes."
				return 1
			}
		} always {
			case "$gpgsign" in
				("") command git config --unset commit.gpgsign ;;
				(*) command git config commit.gpgsign "$gpgsign" ;;
			esac
		}
		_omz::log info "fetch of PR #${1} successful."
	)
	[[ $? -eq 0 ]] || return 1
	_omz::log info "running \`zsh\` to test the changes. Run \`exit\` to go back."
	command zsh -l
	_omz::confirm "do you want to go back to the previous branch? [Y/n] "
	[[ "$REPLY" != [yY$'\n'] ]] && return
	(
		set -e
		builtin cd -q "$ZSH"
		command git checkout "$branch" -- || {
			_omz::log error "could not go back to the previous branch ('$branch')."
			return 1
		}
	)
}
_omz::reload () {
	command rm -f $_comp_dumpfile $ZSH_COMPDUMP
	local zsh="${ZSH_ARGZERO:-${functrace[-1]%:*}}" 
	[[ "$zsh" = -* || -o login ]] && exec -l "${zsh#-}" || exec "$zsh"
}
_omz::shop () {
	local shop_url="https://commitgoods.com/collections/oh-my-zsh" 
	_omz::log info "Opening Oh My Zsh shop in your browser..."
	_omz::log info "$shop_url"
	open_command "$shop_url"
}
_omz::theme () {
	(( $# > 0 && $+functions[$0::$1] )) || {
		cat >&2 <<EOF
Usage: ${(j: :)${(s.::.)0#_}} <command> [options]

Available commands:

  list            List all available Oh My Zsh themes
  set <theme>     Set a theme in your .zshrc file
  use <theme>     Load a theme

EOF
		return 1
	}
	local command="$1" 
	shift
	$0::$command "$@"
}
_omz::theme::list () {
	local -a custom_themes builtin_themes
	custom_themes=("$ZSH_CUSTOM"/**/*.zsh-theme(-.N:r:gs:"$ZSH_CUSTOM"/themes/:::gs:"$ZSH_CUSTOM"/:::)) 
	builtin_themes=("$ZSH"/themes/*.zsh-theme(-.N:t:r)) 
	if [[ ! -t 1 ]]
	then
		print -l ${(q-)custom_themes} ${(q-)builtin_themes}
		return
	fi
	if [[ -n "$ZSH_THEME" ]]
	then
		print -Pn "%U%BCurrent theme%b%u: "
		[[ $ZSH_THEME = random ]] && echo "$RANDOM_THEME (via random)" || echo "$ZSH_THEME"
		echo
	fi
	if (( ${#custom_themes} ))
	then
		print -P "%U%BCustom themes%b%u:"
		print -lac ${(q-)custom_themes}
		echo
	fi
	print -P "%U%BBuilt-in themes%b%u:"
	print -lac ${(q-)builtin_themes}
}
_omz::theme::set () {
	if [[ -z "$1" ]]
	then
		echo "Usage: ${(j: :)${(s.::.)0#_}} <theme>" >&2
		return 1
	fi
	if [[ ! -f "$ZSH_CUSTOM/$1.zsh-theme" ]] && [[ ! -f "$ZSH_CUSTOM/themes/$1.zsh-theme" ]] && [[ ! -f "$ZSH/themes/$1.zsh-theme" ]]
	then
		_omz::log error "%B$1%b theme not found"
		return 1
	fi
	local awk_script='
!set && /^[ \t]*ZSH_THEME=[^#]+.*$/ {
  set=1
  sub(/^[ \t]*ZSH_THEME=[^#]+.*$/, "ZSH_THEME=\"'$1'\" # set by `omz`")
  print $0
  next
}

{ print $0 }

END {
  # If no ZSH_THEME= line was found, return an error
  if (!set) exit 1
}
' 
	local zdot="${ZDOTDIR:-$HOME}" 
	local zshrc="${${:-"${zdot}/.zshrc"}:A}" 
	awk "$awk_script" "$zshrc" > "$zdot/.zshrc.new" || {
		cat <<EOF
ZSH_THEME="$1" # set by \`omz\`

EOF
		cat "$zdot/.zshrc"
	} > "$zdot/.zshrc.new" && command cp -f "$zshrc" "$zdot/.zshrc.bck" && command mv -f "$zdot/.zshrc.new" "$zshrc"
	[[ $? -eq 0 ]] || {
		local ret=$? 
		_omz::log error "error setting theme."
		return $ret
	}
	if ! command zsh -n "$zdot/.zshrc"
	then
		_omz::log error "broken syntax in '"${zdot/#$HOME/\~}/.zshrc"'. Rolling back changes..."
		command mv -f "$zdot/.zshrc.bck" "$zshrc"
		return 1
	fi
	_omz::log info "'$1' theme set correctly."
	[[ ! -o interactive ]] || _omz::reload
}
_omz::theme::use () {
	if [[ -z "$1" ]]
	then
		echo "Usage: ${(j: :)${(s.::.)0#_}} <theme>" >&2
		return 1
	fi
	if [[ -f "$ZSH_CUSTOM/$1.zsh-theme" ]]
	then
		source "$ZSH_CUSTOM/$1.zsh-theme"
	elif [[ -f "$ZSH_CUSTOM/themes/$1.zsh-theme" ]]
	then
		source "$ZSH_CUSTOM/themes/$1.zsh-theme"
	elif [[ -f "$ZSH/themes/$1.zsh-theme" ]]
	then
		source "$ZSH/themes/$1.zsh-theme"
	else
		_omz::log error "%B$1%b theme not found"
		return 1
	fi
	ZSH_THEME="$1" 
	[[ $1 = random ]] || unset RANDOM_THEME
}
_omz::update () {
	(( $+commands[git] )) || {
		_omz::log error "git is not installed. Aborting..."
		return 1
	}
	[[ "$1" != --unattended ]] || {
		_omz::log error "the \`\e[2m--unattended\e[0m\` flag is no longer supported, use the \`\e[2mupgrade.sh\e[0m\` script instead."
		_omz::log error "for more information see https://github.com/ohmyzsh/ohmyzsh/wiki/FAQ#how-do-i-update-oh-my-zsh"
		return 1
	}
	local last_commit=$(builtin cd -q "$ZSH"; git rev-parse HEAD 2>/dev/null) 
	[[ $? -eq 0 ]] || {
		_omz::log error "\`$ZSH\` is not a git directory. Aborting..."
		return 1
	}
	zstyle -s ':omz:update' verbose verbose_mode || verbose_mode=default 
	ZSH="$ZSH" command zsh -f "$ZSH/tools/upgrade.sh" -i -v $verbose_mode || return $?
	zmodload zsh/datetime
	echo "LAST_EPOCH=$(( EPOCHSECONDS / 60 / 60 / 24 ))" >| "${ZSH_CACHE_DIR}/.zsh-update"
	command rm -rf "$ZSH/log/update.lock"
	if [[ "$(builtin cd -q "$ZSH"; git rev-parse HEAD)" != "$last_commit" ]]
	then
		local zsh="${ZSH_ARGZERO:-${functrace[-1]%:*}}" 
		[[ "$zsh" = -* || -o login ]] && exec -l "${zsh#-}" || exec "$zsh"
	fi
}
_omz::version () {
	(
		builtin cd -q "$ZSH"
		local version
		version=$(command git describe --tags HEAD 2>/dev/null)  || version=$(command git symbolic-ref --quiet --short HEAD 2>/dev/null)  || version=$(command git name-rev --no-undefined --name-only --exclude="remotes/*" HEAD 2>/dev/null)  || version="<detached>" 
		local commit=$(command git rev-parse --short HEAD 2>/dev/null) 
		printf "%s (%s)\n" "$version" "$commit"
	)
}
_omz_async_callback () {
	emulate -L zsh
	local fd=$1 
	local err=$2 
	if [[ -z "$err" || "$err" == "hup" ]]
	then
		local handler="${(k)_OMZ_ASYNC_FDS[(r)$fd]}" 
		local old_output="${_OMZ_ASYNC_OUTPUT[$handler]}" 
		IFS= read -r -u $fd -d '' "_OMZ_ASYNC_OUTPUT[$handler]"
		if [[ "$old_output" != "${_OMZ_ASYNC_OUTPUT[$handler]}" ]]
		then
			zle .reset-prompt
			zle -R
		fi
		exec {fd}<&-
	fi
	zle -F "$fd"
	_OMZ_ASYNC_FDS[$handler]=-1 
	_OMZ_ASYNC_PIDS[$handler]=-1 
}
_omz_async_request () {
	setopt localoptions noksharrays unset
	local -i ret=$? 
	typeset -gA _OMZ_ASYNC_FDS _OMZ_ASYNC_PIDS _OMZ_ASYNC_OUTPUT
	local handler
	for handler in ${_omz_async_functions}
	do
		(( ${+functions[$handler]} )) || continue
		local fd=${_OMZ_ASYNC_FDS[$handler]:--1} 
		local pid=${_OMZ_ASYNC_PIDS[$handler]:--1} 
		if (( fd != -1 && pid != -1 )) && {
				true <&$fd
			} 2> /dev/null
		then
			exec {fd}<&-
			zle -F $fd
			if [[ -o MONITOR ]]
			then
				kill -TERM -$pid 2> /dev/null
			else
				kill -TERM $pid 2> /dev/null
			fi
		fi
		_OMZ_ASYNC_FDS[$handler]=-1 
		_OMZ_ASYNC_PIDS[$handler]=-1 
		exec {fd}< <(
      # Tell parent process our PID
      builtin echo ${sysparams[pid]}
      # Set exit code for the handler if used
      () { return $ret }
      # Run the async function handler
      $handler
    )
		_OMZ_ASYNC_FDS[$handler]=$fd 
		is-at-least 5.8 || command true
		read -u $fd "_OMZ_ASYNC_PIDS[$handler]"
		zle -F "$fd" _omz_async_callback
	done
}
_omz_diag_dump_check_core_commands () {
	builtin echo "Core command check:"
	local redefined name builtins externals reserved_words
	redefined=() 
	reserved_words=(do done esac then elif else fi for case if while function repeat time until select coproc nocorrect foreach end '!' '[[' '{' '}') 
	builtins=(alias autoload bg bindkey break builtin bye cd chdir command comparguments compcall compctl compdescribe compfiles compgroups compquote comptags comptry compvalues continue dirs disable disown echo echotc echoti emulate enable eval exec exit false fc fg functions getln getopts hash jobs kill let limit log logout noglob popd print printf pushd pushln pwd r read rehash return sched set setopt shift source suspend test times trap true ttyctl type ulimit umask unalias unfunction unhash unlimit unset unsetopt vared wait whence where which zcompile zle zmodload zparseopts zregexparse zstyle) 
	if is-at-least 5.1
	then
		reserved_word+=(declare export integer float local readonly typeset) 
	else
		builtins+=(declare export integer float local readonly typeset) 
	fi
	builtins_fatal=(builtin command local) 
	externals=(zsh) 
	for name in $reserved_words
	do
		if [[ $(builtin whence -w $name) != "$name: reserved" ]]
		then
			builtin echo "reserved word '$name' has been redefined"
			builtin which $name
			redefined+=$name 
		fi
	done
	for name in $builtins
	do
		if [[ $(builtin whence -w $name) != "$name: builtin" ]]
		then
			builtin echo "builtin '$name' has been redefined"
			builtin which $name
			redefined+=$name 
		fi
	done
	for name in $externals
	do
		if [[ $(builtin whence -w $name) != "$name: command" ]]
		then
			builtin echo "command '$name' has been redefined"
			builtin which $name
			redefined+=$name 
		fi
	done
	if [[ -n "$redefined" ]]
	then
		builtin echo "SOME CORE COMMANDS HAVE BEEN REDEFINED: $redefined"
	else
		builtin echo "All core commands are defined normally"
	fi
}
_omz_diag_dump_echo_file_w_header () {
	local file=$1 
	if [[ -f $file || -h $file ]]
	then
		builtin echo "========== $file =========="
		if [[ -h $file ]]
		then
			builtin echo "==========    ( => ${file:A} )   =========="
		fi
		command cat $file
		builtin echo "========== end $file =========="
		builtin echo
	elif [[ -d $file ]]
	then
		builtin echo "File '$file' is a directory"
	elif [[ ! -e $file ]]
	then
		builtin echo "File '$file' does not exist"
	else
		command ls -lad "$file"
	fi
}
_omz_diag_dump_one_big_text () {
	local program programs progfile md5
	builtin echo oh-my-zsh diagnostic dump
	builtin echo
	builtin echo $outfile
	builtin echo
	command date
	command uname -a
	builtin echo OSTYPE=$OSTYPE
	builtin echo ZSH_VERSION=$ZSH_VERSION
	builtin echo User: $USERNAME
	builtin echo umask: $(umask)
	builtin echo
	_omz_diag_dump_os_specific_version
	builtin echo
	programs=(sh zsh ksh bash sed cat grep ls find git posh) 
	local progfile="" extra_str="" sha_str="" 
	for program in $programs
	do
		extra_str="" sha_str="" 
		progfile=$(builtin which $program) 
		if [[ $? == 0 ]]
		then
			if [[ -e $progfile ]]
			then
				if builtin whence shasum &> /dev/null
				then
					sha_str=($(command shasum $progfile)) 
					sha_str=$sha_str[1] 
					extra_str+=" SHA $sha_str" 
				fi
				if [[ -h "$progfile" ]]
				then
					extra_str+=" ( -> ${progfile:A} )" 
				fi
			fi
			builtin printf '%-9s %-20s %s\n' "$program is" "$progfile" "$extra_str"
		else
			builtin echo "$program: not found"
		fi
	done
	builtin echo
	builtin echo Command Versions:
	builtin echo "zsh: $(zsh --version)"
	builtin echo "this zsh session: $ZSH_VERSION"
	builtin echo "bash: $(bash --version | command grep bash)"
	builtin echo "git: $(git --version)"
	builtin echo "grep: $(grep --version)"
	builtin echo
	_omz_diag_dump_check_core_commands || return 1
	builtin echo
	builtin echo Process state:
	builtin echo pwd: $PWD
	if builtin whence pstree &> /dev/null
	then
		builtin echo Process tree for this shell:
		pstree -p $$
	else
		ps -fT
	fi
	builtin set | command grep -a '^\(ZSH\|plugins\|TERM\|LC_\|LANG\|precmd\|chpwd\|preexec\|FPATH\|TTY\|DISPLAY\|PATH\)\|OMZ'
	builtin echo
	builtin echo Exported:
	builtin echo $(builtin export | command sed 's/=.*//')
	builtin echo
	builtin echo Locale:
	command locale
	builtin echo
	builtin echo Zsh configuration:
	builtin echo setopt: $(builtin setopt)
	builtin echo
	builtin echo zstyle:
	builtin zstyle
	builtin echo
	builtin echo 'compaudit output:'
	compaudit
	builtin echo
	builtin echo '$fpath directories:'
	command ls -lad $fpath
	builtin echo
	builtin echo oh-my-zsh installation:
	command ls -ld ~/.z*
	command ls -ld ~/.oh*
	builtin echo
	builtin echo oh-my-zsh git state:
	(
		builtin cd $ZSH && builtin echo "HEAD: $(git rev-parse HEAD)" && git remote -v && git status | command grep "[^[:space:]]"
	)
	if [[ $verbose -ge 1 ]]
	then
		(
			builtin cd $ZSH && git reflog --date=default | command grep pull
		)
	fi
	builtin echo
	if [[ -e $ZSH_CUSTOM ]]
	then
		local custom_dir=$ZSH_CUSTOM 
		if [[ -h $custom_dir ]]
		then
			custom_dir=$(builtin cd $custom_dir && pwd -P) 
		fi
		builtin echo "oh-my-zsh custom dir:"
		builtin echo "   $ZSH_CUSTOM ($custom_dir)"
		(
			builtin cd ${custom_dir:h} && command find ${custom_dir:t} -name .git -prune -o -print
		)
		builtin echo
	fi
	if [[ $verbose -ge 1 ]]
	then
		builtin echo "bindkey:"
		builtin bindkey
		builtin echo
		builtin echo "infocmp:"
		command infocmp -L
		builtin echo
	fi
	local zdotdir=${ZDOTDIR:-$HOME} 
	builtin echo "Zsh configuration files:"
	local cfgfile cfgfiles
	cfgfiles=(/etc/zshenv /etc/zprofile /etc/zshrc /etc/zlogin /etc/zlogout $zdotdir/.zshenv $zdotdir/.zprofile $zdotdir/.zshrc $zdotdir/.zlogin $zdotdir/.zlogout ~/.zsh.pre-oh-my-zsh /etc/bashrc /etc/profile ~/.bashrc ~/.profile ~/.bash_profile ~/.bash_logout) 
	command ls -lad $cfgfiles 2>&1
	builtin echo
	if [[ $verbose -ge 1 ]]
	then
		for cfgfile in $cfgfiles
		do
			_omz_diag_dump_echo_file_w_header $cfgfile
		done
	fi
	builtin echo
	builtin echo "Zsh compdump files:"
	local dumpfile dumpfiles
	command ls -lad $zdotdir/.zcompdump*
	dumpfiles=($zdotdir/.zcompdump*(N)) 
	if [[ $verbose -ge 2 ]]
	then
		for dumpfile in $dumpfiles
		do
			_omz_diag_dump_echo_file_w_header $dumpfile
		done
	fi
}
_omz_diag_dump_os_specific_version () {
	local osname osver version_file version_files
	case "$OSTYPE" in
		(darwin*) osname=$(command sw_vers -productName) 
			osver=$(command sw_vers -productVersion) 
			builtin echo "OS Version: $osname $osver build $(sw_vers -buildVersion)" ;;
		(cygwin) command systeminfo | command head -n 4 | command tail -n 2 ;;
	esac
	if builtin which lsb_release > /dev/null
	then
		builtin echo "OS Release: $(command lsb_release -s -d)"
	fi
	version_files=(/etc/*-release(N) /etc/*-version(N) /etc/*_version(N)) 
	for version_file in $version_files
	do
		builtin echo "$version_file:"
		command cat "$version_file"
		builtin echo
	done
}
_omz_git_prompt_info () {
	if ! __git_prompt_git rev-parse --git-dir &> /dev/null || [[ "$(__git_prompt_git config --get oh-my-zsh.hide-info 2>/dev/null)" == 1 ]]
	then
		return 0
	fi
	local ref
	ref=$(__git_prompt_git symbolic-ref --short HEAD 2> /dev/null)  || ref=$(__git_prompt_git describe --tags --exact-match HEAD 2> /dev/null)  || ref=$(__git_prompt_git rev-parse --short HEAD 2> /dev/null)  || return 0
	local upstream
	if (( ${+ZSH_THEME_GIT_SHOW_UPSTREAM} ))
	then
		upstream=$(__git_prompt_git rev-parse --abbrev-ref --symbolic-full-name "@{upstream}" 2>/dev/null)  && upstream=" -> ${upstream}" 
	fi
	echo "${ZSH_THEME_GIT_PROMPT_PREFIX}${ref//\%/%%}${upstream//\%/%%}$(parse_git_dirty)${ZSH_THEME_GIT_PROMPT_SUFFIX}"
}
_omz_git_prompt_status () {
	[[ "$(__git_prompt_git config --get oh-my-zsh.hide-status 2>/dev/null)" = 1 ]] && return
	local -A prefix_constant_map
	prefix_constant_map=('\?\? ' 'UNTRACKED' 'A  ' 'ADDED' 'M  ' 'MODIFIED' 'MM ' 'MODIFIED' ' M ' 'MODIFIED' 'AM ' 'MODIFIED' ' T ' 'MODIFIED' 'R  ' 'RENAMED' ' D ' 'DELETED' 'D  ' 'DELETED' 'UU ' 'UNMERGED' 'ahead' 'AHEAD' 'behind' 'BEHIND' 'diverged' 'DIVERGED' 'stashed' 'STASHED') 
	local -A constant_prompt_map
	constant_prompt_map=('UNTRACKED' "$ZSH_THEME_GIT_PROMPT_UNTRACKED" 'ADDED' "$ZSH_THEME_GIT_PROMPT_ADDED" 'MODIFIED' "$ZSH_THEME_GIT_PROMPT_MODIFIED" 'RENAMED' "$ZSH_THEME_GIT_PROMPT_RENAMED" 'DELETED' "$ZSH_THEME_GIT_PROMPT_DELETED" 'UNMERGED' "$ZSH_THEME_GIT_PROMPT_UNMERGED" 'AHEAD' "$ZSH_THEME_GIT_PROMPT_AHEAD" 'BEHIND' "$ZSH_THEME_GIT_PROMPT_BEHIND" 'DIVERGED' "$ZSH_THEME_GIT_PROMPT_DIVERGED" 'STASHED' "$ZSH_THEME_GIT_PROMPT_STASHED") 
	local status_constants
	status_constants=(UNTRACKED ADDED MODIFIED RENAMED DELETED STASHED UNMERGED AHEAD BEHIND DIVERGED) 
	local status_text
	status_text="$(__git_prompt_git status --porcelain -b 2> /dev/null)" 
	if [[ $? -eq 128 ]]
	then
		return 1
	fi
	local -A statuses_seen
	if __git_prompt_git rev-parse --verify refs/stash &> /dev/null
	then
		statuses_seen[STASHED]=1 
	fi
	local status_lines
	status_lines=("${(@f)${status_text}}") 
	if [[ "$status_lines[1]" =~ "^## [^ ]+ \[(.*)\]" ]]
	then
		local branch_statuses
		branch_statuses=("${(@s/,/)match}") 
		for branch_status in $branch_statuses
		do
			if [[ ! $branch_status =~ "(behind|diverged|ahead) ([0-9]+)?" ]]
			then
				continue
			fi
			local last_parsed_status=$prefix_constant_map[$match[1]] 
			statuses_seen[$last_parsed_status]=$match[2] 
		done
	fi
	for status_prefix in "${(@k)prefix_constant_map}"
	do
		local status_constant="${prefix_constant_map[$status_prefix]}" 
		local status_regex=$'(^|\n)'"$status_prefix" 
		if [[ "$status_text" =~ $status_regex ]]
		then
			statuses_seen[$status_constant]=1 
		fi
	done
	local status_prompt
	for status_constant in $status_constants
	do
		if (( ${+statuses_seen[$status_constant]} ))
		then
			local next_display=$constant_prompt_map[$status_constant] 
			status_prompt="$next_display$status_prompt" 
		fi
	done
	echo $status_prompt
}
_omz_register_handler () {
	setopt localoptions noksharrays unset
	typeset -ga _omz_async_functions
	if [[ -z "$1" ]] || (( ! ${+functions[$1]} )) || (( ${_omz_async_functions[(Ie)$1]} ))
	then
		return
	fi
	_omz_async_functions+=("$1") 
	if (( ! ${precmd_functions[(Ie)_omz_async_request]} )) && (( ${+functions[_omz_async_request]}))
	then
		autoload -Uz add-zsh-hook
		add-zsh-hook precmd _omz_async_request
	fi
}
_omz_source () {
	local context filepath="$1" 
	case "$filepath" in
		(lib/*) context="lib:${filepath:t:r}"  ;;
		(plugins/*) context="plugins:${filepath:h:t}"  ;;
	esac
	local disable_aliases=0 
	zstyle -T ":omz:${context}" aliases || disable_aliases=1 
	local -A aliases_pre galiases_pre
	if (( disable_aliases ))
	then
		aliases_pre=("${(@kv)aliases}") 
		galiases_pre=("${(@kv)galiases}") 
	fi
	if [[ -f "$ZSH_CUSTOM/$filepath" ]]
	then
		source "$ZSH_CUSTOM/$filepath"
	elif [[ -f "$ZSH/$filepath" ]]
	then
		source "$ZSH/$filepath"
	fi
	if (( disable_aliases ))
	then
		if (( #aliases_pre ))
		then
			aliases=("${(@kv)aliases_pre}") 
		else
			(( #aliases )) && unalias "${(@k)aliases}"
		fi
		if (( #galiases_pre ))
		then
			galiases=("${(@kv)galiases_pre}") 
		else
			(( #galiases )) && unalias "${(@k)galiases}"
		fi
	fi
}
_open () {
	# undefined
	builtin autoload -XUz
}
_openclaw_acp () {
	local -a commands
	local -a options
	_arguments -C "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--token-file[Read gateway token from file]" "--password[Gateway password (if required)]" "--password-file[Read gateway password from file]" "--session[Default session key (e.g. agent:main:main)]" "--session-label[Default session label to resolve]" "--require-existing[Fail if the session key/label does not exist]" "--reset-session[Reset the session key before first use]" "--no-prefix-cwd[Do not prefix prompts with the working directory]" "--provenance[ACP provenance mode: off, meta, or meta+receipt]" "(--verbose -v)"{--verbose,-v}"[Verbose logging to stderr]" "1: :_values 'command' 'client[Run an interactive ACP client against the local ACP bridge]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(client) _openclaw_acp_client ;;
			esac ;;
	esac
}
_openclaw_acp_client () {
	_arguments -C "--cwd[Working directory for the ACP session]" "--server[ACP server command (default: openclaw)]" "--server-args[Extra arguments for the ACP server]" "--server-verbose[Enable verbose logging on the ACP server]" "(--verbose -v)"{--verbose,-v}"[Verbose client logging]"
}
_openclaw_agent () {
	_arguments -C "(--message -m)"{--message,-m}"[Message body for the agent]" "(--to -t)"{--to,-t}"[Recipient number in E.164 used to derive the session key]" "--session-key[Explicit session key (agent:<id>:<key>, or scoped to --agent)]" "--session-id[Use an explicit session id]" "--agent[Agent id (overrides routing bindings)]" "--model[Model override for this run (provider/model or model id)]" "--thinking[Thinking level: off | minimal | low | medium | high | xhigh | adaptive | max where supported]" "--verbose[Persist agent verbose level for the session]" "--channel[Delivery channel: last|telegram|whatsapp|discord|irc|googlechat|slack|signal|imessage|feishu|nostr|msteams|mattermost|nextcloud-talk|matrix|line|zalo|clickclack|zalouser|synology-chat|tlon|qa-channel|qqbot|twitch (omit to use the main session channel)]" "--reply-to[Delivery target override (separate from session routing)]" "--reply-channel[Delivery channel override (separate from routing)]" "--reply-account[Delivery account id override]" "--local[Run the embedded agent locally (requires model provider API keys in your shell)]" "--deliver[Send the agent'\''s reply back to the selected channel]" "--json[Output result as JSON]" "--timeout[Override agent command timeout (seconds, default 600 or config value)]"
}
_openclaw_agents () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'list[List configured agents]' 'bindings[List routing bindings]' 'bind[Add routing bindings for an agent]' 'unbind[Remove routing bindings for an agent]' 'add[Add a new isolated agent]' 'set-identity[Update an agent identity (name/theme/emoji/avatar)]' 'delete[Delete an agent and prune workspace/state]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(list) _openclaw_agents_list ;;
				(bindings) _openclaw_agents_bindings ;;
				(bind) _openclaw_agents_bind ;;
				(unbind) _openclaw_agents_unbind ;;
				(add) _openclaw_agents_add ;;
				(set-identity) _openclaw_agents_set_identity ;;
				(delete) _openclaw_agents_delete ;;
			esac ;;
	esac
}
_openclaw_agents_add () {
	_arguments -C "--workspace[Workspace directory for the new agent]" "--model[Model id for this agent]" "--agent-dir[Agent state directory for this agent]" "--bind[Route channel binding (repeatable)]" "--non-interactive[Disable prompts; requires --workspace]" "--json[Output JSON summary]"
}
_openclaw_agents_bind () {
	_arguments -C "--agent[Agent id (defaults to current default agent)]" "--bind[Binding to add (repeatable). If omitted, accountId is resolved by channel defaults/hooks.]" "--json[Output JSON summary]"
}
_openclaw_agents_bindings () {
	_arguments -C "--agent[Filter by agent id]" "--json[Output JSON instead of text]"
}
_openclaw_agents_delete () {
	_arguments -C "--force[Skip confirmation]" "--json[Output JSON summary]"
}
_openclaw_agents_list () {
	_arguments -C "--json[Output JSON instead of text]" "--bindings[Include routing bindings]"
}
_openclaw_agents_set_identity () {
	_arguments -C "--agent[Agent id to update]" "--workspace[Workspace directory used to locate the agent + IDENTITY.md]" "--identity-file[Explicit IDENTITY.md path to read]" "--from-identity[Read values from IDENTITY.md]" "--name[Identity name]" "--theme[Identity theme]" "--emoji[Identity emoji]" "--avatar[Identity avatar (workspace path, http(s) URL, or data URI)]" "--json[Output JSON summary]"
}
_openclaw_agents_unbind () {
	_arguments -C "--agent[Agent id (defaults to current default agent)]" "--bind[Binding to remove (repeatable)]" "--all[Remove all bindings for this agent]" "--json[Output JSON summary]"
}
_openclaw_approvals () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'get[Fetch exec approvals snapshot]' 'set[Replace exec approvals with a JSON file]' 'allowlist[Edit the per-agent allowlist]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(get) _openclaw_approvals_get ;;
				(set) _openclaw_approvals_set ;;
				(allowlist) _openclaw_approvals_allowlist ;;
			esac ;;
	esac
}
_openclaw_approvals_allowlist () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'add[Add a glob pattern to an allowlist]' 'remove[Remove a glob pattern from an allowlist]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(add) _openclaw_approvals_allowlist_add ;;
				(remove) _openclaw_approvals_allowlist_remove ;;
			esac ;;
	esac
}
_openclaw_approvals_allowlist_add () {
	_arguments -C "--node[Target node id/name/IP]" "--gateway[Force gateway approvals]" "--agent[Agent id (defaults to \"*\")]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--json[Output JSON]"
}
_openclaw_approvals_allowlist_remove () {
	_arguments -C "--node[Target node id/name/IP]" "--gateway[Force gateway approvals]" "--agent[Agent id (defaults to \"*\")]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--json[Output JSON]"
}
_openclaw_approvals_get () {
	_arguments -C "--node[Target node id/name/IP]" "--gateway[Force gateway approvals]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--json[Output JSON]"
}
_openclaw_approvals_set () {
	_arguments -C "--node[Target node id/name/IP]" "--gateway[Force gateway approvals]" "--file[Path to JSON file to upload]" "--stdin[Read JSON from stdin]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--json[Output JSON]"
}
_openclaw_backup () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'create[Write a backup archive for config, credentials, sessions, and workspaces]' 'verify[Validate a backup archive and its embedded manifest]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(create) _openclaw_backup_create ;;
				(verify) _openclaw_backup_verify ;;
			esac ;;
	esac
}
_openclaw_backup_create () {
	_arguments -C "--output[Archive path or destination directory]" "--json[Output JSON]" "--dry-run[Print the backup plan without writing the archive]" "--verify[Verify the archive after writing it]" "--only-config[Back up only the active JSON config file]" "--no-include-workspace[Exclude workspace directories from the backup]"
}
_openclaw_backup_verify () {
	_arguments -C "--json[Output JSON]"
}
_openclaw_channels () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'list[List chat channels (configured by default; pass --all for installable catalog)]' 'status[Show gateway channel status (use status --deep for local)]' 'capabilities[Show provider capabilities (intents/scopes + supported features)]' 'resolve[Resolve channel/user names to IDs]' 'logs[Show recent channel logs from the gateway log file]' 'add[Add or update a channel account]' 'remove[Disable or delete a channel account]' 'login[Link a channel account (if supported)]' 'logout[Log out of a channel session (if supported)]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(list) _openclaw_channels_list ;;
				(status) _openclaw_channels_status ;;
				(capabilities) _openclaw_channels_capabilities ;;
				(resolve) _openclaw_channels_resolve ;;
				(logs) _openclaw_channels_logs ;;
				(add) _openclaw_channels_add ;;
				(remove) _openclaw_channels_remove ;;
				(login) _openclaw_channels_login ;;
				(logout) _openclaw_channels_logout ;;
			esac ;;
	esac
}
_openclaw_channels_add () {
	_arguments -C "--channel[Channel (telegram|whatsapp|discord|irc|googlechat|slack|signal|imessage|feishu|nostr|msteams|mattermost|nextcloud-talk|matrix|line|zalo|clickclack|zalouser|synology-chat|tlon|qa-channel|qqbot|twitch)]" "--account[Account id (default when omitted)]" "--name[Display name for this account]" "--token[Channel token or credential payload]" "--token-file[Read channel token or credential payload from file]" "--secret[Channel shared secret]" "--secret-file[Read channel shared secret from file]" "--bot-token[Bot token]" "--app-token[App token]" "--password[Channel password or login secret]" "--cli-path[Channel CLI path]" "--url[Channel setup URL]" "--base-url[Channel base URL]" "--http-url[Channel HTTP service URL]" "--auth-dir[Channel auth directory override]" "--use-env[Use env-backed credentials when supported]" "--db-path[iMessage database path]" "--service[iMessage service (imessage|sms|auto)]" "--region[iMessage region (for SMS)]" "--signal-number[Signal account number (E.164)]" "--http-host[Signal HTTP daemon host]" "--http-port[Signal HTTP daemon port]"
}
_openclaw_channels_capabilities () {
	_arguments -C "--channel[Channel (all|telegram|whatsapp|discord|irc|googlechat|slack|signal|imessage|feishu|nostr|msteams|mattermost|nextcloud-talk|matrix|line|zalo|clickclack|zalouser|synology-chat|tlon|qa-channel|qqbot|twitch)]" "--account[Account id (only with --channel)]" "--target[Channel target for permission audit (Discord channel:<id>)]" "--timeout[Timeout in ms]" "--json[Output JSON]"
}
_openclaw_channels_list () {
	_arguments -C "--all[Include bundled and installable catalog channels]" "--json[Output JSON]"
}
_openclaw_channels_login () {
	_arguments -C "--channel[Channel alias (auto when only one is configured)]" "--account[Account id (accountId)]" "--verbose[Verbose connection logs]"
}
_openclaw_channels_logout () {
	_arguments -C "--channel[Channel alias (auto when only one is configured)]" "--account[Account id (accountId)]"
}
_openclaw_channels_logs () {
	_arguments -C "--channel[Channel (all|telegram|whatsapp|discord|irc|googlechat|slack|signal|imessage|feishu|nostr|msteams|mattermost|nextcloud-talk|matrix|line|zalo|clickclack|zalouser|synology-chat|tlon|qa-channel|qqbot|twitch)]" "--lines[Number of lines (default: 200)]" "--json[Output JSON]"
}
_openclaw_channels_remove () {
	_arguments -C "--channel[Channel (telegram|whatsapp|discord|irc|googlechat|slack|signal|imessage|feishu|nostr|msteams|mattermost|nextcloud-talk|matrix|line|zalo|clickclack|zalouser|synology-chat|tlon|qa-channel|qqbot|twitch)]" "--account[Account id (default when omitted)]" "--delete[Delete config entries (no prompt)]"
}
_openclaw_channels_resolve () {
	_arguments -C "--channel[Channel (telegram|whatsapp|discord|irc|googlechat|slack|signal|imessage|feishu|nostr|msteams|mattermost|nextcloud-talk|matrix|line|zalo|clickclack|zalouser|synology-chat|tlon|qa-channel|qqbot|twitch)]" "--account[Account id (accountId)]" "--kind[Target kind (auto|user|group)]" "--json[Output JSON]"
}
_openclaw_channels_status () {
	_arguments -C "--channel[Only show one channel (all|telegram|whatsapp|discord|irc|googlechat|slack|signal|imessage|feishu|nostr|msteams|mattermost|nextcloud-talk|matrix|line|zalo|clickclack|zalouser|synology-chat|tlon|qa-channel|qqbot|twitch)]" "--probe[Probe channel credentials]" "--timeout[Timeout in ms]" "--json[Output JSON]"
}
_openclaw_clawbot () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'qr[Generate a mobile pairing QR code and setup code]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(qr) _openclaw_clawbot_qr ;;
			esac ;;
	esac
}
_openclaw_clawbot_qr () {
	_arguments -C "--remote[Use gateway.remote.url and gateway.remote token/password (ignores device-pair publicUrl)]" "--url[Override gateway URL used in the setup payload]" "--public-url[Override gateway public URL used in the setup payload]" "--token[Override gateway token for setup payload]" "--password[Override gateway password for setup payload]" "--setup-code-only[Print only the setup code]" "--no-ascii[Skip ASCII QR rendering]" "--json[Output JSON]"
}
_openclaw_commitments () {
	local -a commands
	local -a options
	_arguments -C "--json[Output JSON instead of text]" "--agent[Agent id to inspect]" "--status[Filter by status (pending, sent, dismissed, snoozed, expired)]" "--all[Show all statuses]" "1: :_values 'command' 'list[List inferred follow-up commitments]' 'dismiss[Dismiss inferred follow-up commitments]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(list) _openclaw_commitments_list ;;
				(dismiss) _openclaw_commitments_dismiss ;;
			esac ;;
	esac
}
_openclaw_commitments_dismiss () {
	_arguments -C "--json[Output JSON instead of text]"
}
_openclaw_commitments_list () {
	_arguments -C "--json[Output JSON instead of text]" "--agent[Agent id to inspect]" "--status[Filter by status (pending, sent, dismissed, snoozed, expired)]" "--all[Show all statuses]"
}
_openclaw_completion () {
	_arguments -C "(--shell -s)"{--shell,-s}"[Shell to generate completion for (default: zsh)]" "(--install -i)"{--install,-i}"[Install completion script to shell profile]" "--write-state[Write completion scripts to $OPENCLAW_STATE_DIR/completions (no stdout)]" "(--yes -y)"{--yes,-y}"[Skip confirmation (non-interactive)]"
}
_openclaw_config () {
	local -a commands
	local -a options
	_arguments -C "--section[Configuration sections for guided setup (repeatable). Use with no subcommand.]" "1: :_values 'command' 'get[Get a config value by dot path]' 'set[Set config values by path (value mode, ref/provider builder mode, or batch JSON mode).
Examples:
openclaw config set gateway.port 19001 --strict-json
openclaw config set channels.discord.token --ref-provider default --ref-source env --ref-id DISCORD_BOT_TOKEN
openclaw config set secrets.providers.vault --provider-source file --provider-path /etc/openclaw/secrets.json --provider-mode json
openclaw config set --batch-file ./config-set.batch.json --dry-run]' 'patch[Patch config from a JSON5 object in one validated write.
Objects merge recursively, arrays/scalars replace, and null deletes a path.
Examples:
openclaw config patch --file ./openclaw.patch.json5 --dry-run
openclaw config patch --stdin]' 'unset[Remove a config value by dot path]' 'file[Print the active config file path]' 'schema[Print the JSON schema for openclaw.json]' 'validate[Validate the current config against the schema without starting the gateway]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(get) _openclaw_config_get ;;
				(set) _openclaw_config_set ;;
				(patch) _openclaw_config_patch ;;
				(unset) _openclaw_config_unset ;;
				(file) _openclaw_config_file ;;
				(schema) _openclaw_config_schema ;;
				(validate) _openclaw_config_validate ;;
			esac ;;
	esac
}
_openclaw_config_file () {
	_arguments -C
}
_openclaw_config_get () {
	_arguments -C "--json[Output JSON]"
}
_openclaw_config_patch () {
	_arguments -C "--file[Read a JSON5 config patch object from file]" "--stdin[Read a JSON5 config patch object from stdin]" "--dry-run[Validate changes without writing openclaw.json (checks schema and SecretRef resolvability; exec SecretRefs are skipped unless --allow-exec is set)]" "--allow-exec[Dry-run only: allow exec SecretRef resolvability checks (may execute provider commands)]" "--json[Output dry-run result as JSON]" "--replace-path[Replace the object or array at this dot/bracket path instead of recursively applying it (repeatable)]"
}
_openclaw_config_schema () {
	_arguments -C
}
_openclaw_config_set () {
	_arguments -C "--strict-json[Strict JSON parsing (error instead of raw string fallback)]" "--json[Legacy alias for --strict-json]" "--dry-run[Validate changes without writing openclaw.json (checks run in builder/json/batch modes; exec SecretRefs are skipped unless --allow-exec is set)]" "--allow-exec[Dry-run only: allow exec SecretRef resolvability checks (may execute provider commands)]" "--merge[Merge object/map values instead of replacing the target path]" "--replace[Allow full replacement of protected map/list paths such as agents.defaults.models]" "--ref-provider[SecretRef builder: provider alias]" "--ref-source[SecretRef builder: source (env|file|exec)]" "--ref-id[SecretRef builder: ref id]" "--provider-source[Provider builder: source (env|file|exec)]" "--provider-allowlist[Provider builder (env): allowlist entry (repeatable)]" "--provider-path[Provider builder (file): path]" "--provider-mode[Provider builder (file): mode (singleValue|json)]" "--provider-timeout-ms[Provider builder (file|exec): timeout ms]" "--provider-max-bytes[Provider builder (file): max bytes]" "--provider-command[Provider builder (exec): absolute command path]" "--provider-arg[Provider builder (exec): command arg (repeatable)]" "--provider-no-output-timeout-ms[Provider builder (exec): no-output timeout ms]" "--provider-max-output-bytes[Provider builder (exec): max output bytes]" "--provider-json-only[Provider builder (exec): require JSON output]" "--provider-env[Provider builder (exec): env assignment (repeatable)]" "--provider-pass-env[Provider builder (exec): pass host env var (repeatable)]" "--provider-trusted-dir[Provider builder (exec): trusted directory (repeatable)]" "--provider-allow-insecure-path[Provider builder (file|exec): bypass strict path permission checks]" "--provider-allow-symlink-command[Provider builder (exec): allow command symlink path]" "--batch-json[Batch mode: JSON array of set operations]" "--batch-file[Batch mode: read JSON array of set operations from file]"
}
_openclaw_config_unset () {
	_arguments -C "--dry-run[validate the removal without writing the config file]" "--allow-exec[allow exec SecretRef providers during --dry-run]" "--json[print dry-run result as JSON]"
}
_openclaw_config_validate () {
	_arguments -C "--json[Output validation result as JSON]"
}
_openclaw_configure () {
	_arguments -C "--section[Configuration sections (repeatable). Options: workspace, model, web, gateway, daemon, channels, plugins, skills, health]"
}
_openclaw_crestodian () {
	_arguments -C "(--message -m)"{--message,-m}"[Run one Crestodian request]" "--yes[Approve persistent config writes for this request]" "--json[Output startup overview as JSON]"
}
_openclaw_cron () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'status[Show cron scheduler status]' 'list[List cron jobs]' 'add[Add a cron job]' 'rm[Remove a cron job]' 'enable[Enable a cron job]' 'disable[Disable a cron job]' 'get[Get a cron job as JSON]' 'show[Show a cron job]' 'runs[Show cron run history (JSONL-backed)]' 'run[Run a cron job now (debug)]' 'edit[Edit a cron job (patch fields)]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(status) _openclaw_cron_status ;;
				(list) _openclaw_cron_list ;;
				(add) _openclaw_cron_add ;;
				(rm) _openclaw_cron_rm ;;
				(enable) _openclaw_cron_enable ;;
				(disable) _openclaw_cron_disable ;;
				(get) _openclaw_cron_get ;;
				(show) _openclaw_cron_show ;;
				(runs) _openclaw_cron_runs ;;
				(run) _openclaw_cron_run ;;
				(edit) _openclaw_cron_edit ;;
			esac ;;
	esac
}
_openclaw_cron_add () {
	_arguments -C "--name[Job name]" "--description[Optional description]" "--disabled[Create job disabled]" "--delete-after-run[Delete one-shot job after it succeeds]" "--keep-after-run[Keep one-shot job after it succeeds]" "--agent[Agent id for this job]" "--session[Session target (main|isolated)]" "--session-key[Session key for job routing (e.g. agent:my-agent:my-session)]" "--wake[Wake mode (now|next-heartbeat)]" "--at[Run once at time (ISO with offset, or +duration). Use --tz for offset-less datetimes]" "--every[Run every duration (e.g. 10m, 1h)]" "--cron[Cron expression (5-field or 6-field with seconds)]" "--tz[Timezone for cron expressions (IANA; cron default: Gateway host local timezone)]" "--stagger[Cron stagger window (e.g. 30s, 5m)]" "--exact[Disable cron staggering (set stagger to 0)]" "--system-event[System event payload (main session)]" "--message[Agent message payload]" "--thinking[Thinking level for agent jobs (off|minimal|low|medium|high|xhigh)]" "--model[Model override for agent jobs (provider/model or alias)]" "--timeout-seconds[Timeout seconds for agent jobs]" "--light-context[Use lightweight bootstrap context for agent jobs]" "--tools[Tool allow-list (e.g. exec,read,write or exec read write)]" "--announce[Fallback-deliver final text to a chat]" "--deliver[Deprecated (use --announce). Fallback-delivers final text to a chat.]" "--no-deliver[Disable runner fallback delivery]" "--channel[Delivery channel (last|<channel-id>)]" "--to[Delivery destination (E.164, Telegram chatId, or Discord channel/user)]" "--thread-id[Telegram forum topic thread id]" "--account[Channel account id for delivery (multi-account setups)]" "--best-effort-deliver[Do not fail the job if delivery fails]" "--json[Output JSON]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--expect-final[Wait for final response (agent)]"
}
_openclaw_cron_disable () {
	_arguments -C "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--expect-final[Wait for final response (agent)]"
}
_openclaw_cron_edit () {
	_arguments -C "--name[Set name]" "--description[Set description]" "--enable[Enable job]" "--disable[Disable job]" "--delete-after-run[Delete one-shot job after it succeeds]" "--keep-after-run[Keep one-shot job after it succeeds]" "--session[Session target (main|isolated)]" "--agent[Set agent id]" "--clear-agent[Unset agent and use default]" "--session-key[Set session key for job routing]" "--clear-session-key[Unset session key]" "--wake[Wake mode (now|next-heartbeat)]" "--at[Set one-shot time (ISO) or duration like 20m]" "--every[Set interval duration like 10m]" "--cron[Set cron expression]" "--tz[Timezone for cron expressions (IANA; cron default: Gateway host local timezone)]" "--stagger[Cron stagger window (e.g. 30s, 5m)]" "--exact[Disable cron staggering (set stagger to 0)]" "--system-event[Set systemEvent payload]" "--message[Set agentTurn payload message]" "--thinking[Thinking level for agent jobs (off|minimal|low|medium|high|xhigh)]" "--model[Model override for agent jobs]" "--timeout-seconds[Timeout seconds for agent jobs]" "--light-context[Enable lightweight bootstrap context for agent jobs]" "--no-light-context[Disable lightweight bootstrap context for agent jobs]" "--tools[Tool allow-list (e.g. exec,read,write or exec read write)]" "--clear-tools[Remove tool allow-list (use all tools)]" "--announce[Fallback-deliver final text to a chat]" "--deliver[Deprecated (use --announce). Fallback-delivers final text to a chat.]" "--no-deliver[Disable runner fallback delivery]" "--channel[Delivery channel (last|<channel-id>)]" "--to[Delivery destination (E.164, Telegram chatId, or Discord channel/user)]" "--thread-id[Telegram forum topic thread id]" "--account[Channel account id for delivery (multi-account setups)]" "--best-effort-deliver[Do not fail job if delivery fails (also implies --announce when used alone)]" "--no-best-effort-deliver[Fail job when delivery fails]" "--failure-alert[Enable failure alerts for this job]" "--no-failure-alert[Disable failure alerts for this job]" "--failure-alert-after[Alert after N consecutive job errors]" "--failure-alert-channel[Failure alert channel (last|<channel-id>)]" "--failure-alert-to[Failure alert destination]" "--failure-alert-cooldown[Minimum time between alerts (e.g. 1h, 30m)]" "--failure-alert-include-skipped[Count consecutive skipped runs toward alerts]" "--failure-alert-exclude-skipped[Alert only on execution errors]" "--failure-alert-mode[Failure alert delivery mode (announce or webhook)]" "--failure-alert-account-id[Account ID for failure alert channel (multi-account setups)]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--expect-final[Wait for final response (agent)]"
}
_openclaw_cron_enable () {
	_arguments -C "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--expect-final[Wait for final response (agent)]"
}
_openclaw_cron_get () {
	_arguments -C "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--expect-final[Wait for final response (agent)]"
}
_openclaw_cron_list () {
	_arguments -C "--all[Include disabled jobs]" "--agent[Filter by agent id]" "--json[Output JSON]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--expect-final[Wait for final response (agent)]"
}
_openclaw_cron_rm () {
	_arguments -C "--json[Output JSON]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--expect-final[Wait for final response (agent)]"
}
_openclaw_cron_run () {
	_arguments -C "--due[Run only when due (default behavior in older versions)]" "--wait[Wait for the queued run to finish]" "--wait-timeout[Maximum time to wait for --wait]" "--poll-interval[Polling interval for --wait]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--expect-final[Wait for final response (agent)]"
}
_openclaw_cron_runs () {
	_arguments -C "--id[Job id]" "--run-id[Filter by cron run id]" "--limit[Max entries (default 50)]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--expect-final[Wait for final response (agent)]"
}
_openclaw_cron_show () {
	_arguments -C "--json[Output JSON]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--expect-final[Wait for final response (agent)]"
}
_openclaw_cron_status () {
	_arguments -C "--json[Output JSON]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--expect-final[Wait for final response (agent)]"
}
_openclaw_daemon () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'status[Show service install status + probe connectivity/capability]' 'install[Install the Gateway service (launchd/systemd/schtasks)]' 'uninstall[Uninstall the Gateway service (launchd/systemd/schtasks)]' 'start[Start the Gateway service (launchd/systemd/schtasks)]' 'stop[Stop the Gateway service (launchd/systemd/schtasks)]' 'restart[Restart the Gateway service (launchd/systemd/schtasks)]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(status) _openclaw_daemon_status ;;
				(install) _openclaw_daemon_install ;;
				(uninstall) _openclaw_daemon_uninstall ;;
				(start) _openclaw_daemon_start ;;
				(stop) _openclaw_daemon_stop ;;
				(restart) _openclaw_daemon_restart ;;
			esac ;;
	esac
}
_openclaw_daemon_install () {
	_arguments -C "--port[Gateway port]" "--runtime[Daemon runtime (node|bun). Default: node]" "--token[Gateway token (token auth)]" "--wrapper[Executable wrapper for generated service ProgramArguments]" "--force[Reinstall/overwrite if already installed]" "--json[Output JSON]"
}
_openclaw_daemon_restart () {
	_arguments -C "--force[Restart immediately without waiting for active gateway work]" "--safe[Request an OpenClaw-aware restart after active work drains]" "--skip-deferral[Bypass the safe-restart deferral gate; requires --safe]" "--wait[Wait duration before forcing restart (ms, 10s, 5m; 0 waits indefinitely)]" "--json[Output JSON]"
}
_openclaw_daemon_start () {
	_arguments -C "--json[Output JSON]"
}
_openclaw_daemon_status () {
	_arguments -C "--url[Gateway WebSocket URL (defaults to config/remote/local)]" "--token[Gateway token (if required)]" "--password[Gateway password (password auth)]" "--timeout[Timeout in ms]" "--no-probe[Skip RPC probe]" "--require-rpc[Exit non-zero when the RPC probe fails]" "--deep[Scan system-level services]" "--json[Output JSON]"
}
_openclaw_daemon_stop () {
	_arguments -C "--json[Output JSON]" "--disable[Persistently suppress KeepAlive/RunAtLoad so the gateway does not respawn until next start (launchd only)]"
}
_openclaw_daemon_uninstall () {
	_arguments -C "--json[Output JSON]"
}
_openclaw_dashboard () {
	_arguments -C "--no-open[Print URL but do not launch a browser]" "--yes[Start/install the gateway without prompting when needed]"
}
_openclaw_devices () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'list[List pending and paired devices]' 'remove[Remove a paired device entry]' 'clear[Clear paired devices from the gateway table]' 'approve[Approve a pending device pairing request]' 'reject[Reject a pending device pairing request]' 'rotate[Rotate a device token for a role]' 'revoke[Revoke a device token for a role]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(list) _openclaw_devices_list ;;
				(remove) _openclaw_devices_remove ;;
				(clear) _openclaw_devices_clear ;;
				(approve) _openclaw_devices_approve ;;
				(reject) _openclaw_devices_reject ;;
				(rotate) _openclaw_devices_rotate ;;
				(revoke) _openclaw_devices_revoke ;;
			esac ;;
	esac
}
_openclaw_devices_approve () {
	_arguments -C "--latest[Show the most recent pending request to approve explicitly]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--password[Gateway password (password auth)]" "--timeout[Timeout in ms]" "--json[Output JSON]"
}
_openclaw_devices_clear () {
	_arguments -C "--pending[Also reject all pending pairing requests]" "--yes[Confirm destructive clear]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--password[Gateway password (password auth)]" "--timeout[Timeout in ms]" "--json[Output JSON]"
}
_openclaw_devices_list () {
	_arguments -C "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--password[Gateway password (password auth)]" "--timeout[Timeout in ms]" "--json[Output JSON]"
}
_openclaw_devices_reject () {
	_arguments -C "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--password[Gateway password (password auth)]" "--timeout[Timeout in ms]" "--json[Output JSON]"
}
_openclaw_devices_remove () {
	_arguments -C "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--password[Gateway password (password auth)]" "--timeout[Timeout in ms]" "--json[Output JSON]"
}
_openclaw_devices_revoke () {
	_arguments -C "--device[Device id]" "--role[Role name]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--password[Gateway password (password auth)]" "--timeout[Timeout in ms]" "--json[Output JSON]"
}
_openclaw_devices_rotate () {
	_arguments -C "--device[Device id]" "--role[Role name]" "--scope[Scopes to attach to the token (repeatable)]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--password[Gateway password (password auth)]" "--timeout[Timeout in ms]" "--json[Output JSON]"
}
_openclaw_directory () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'self[Show the current account user]' 'peers[Peer directory (contacts/users)]' 'groups[Group directory]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(self) _openclaw_directory_self ;;
				(peers) _openclaw_directory_peers ;;
				(groups) _openclaw_directory_groups ;;
			esac ;;
	esac
}
_openclaw_directory_groups () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'list[List groups]' 'members[List group members]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(list) _openclaw_directory_groups_list ;;
				(members) _openclaw_directory_groups_members ;;
			esac ;;
	esac
}
_openclaw_directory_groups_list () {
	_arguments -C "--channel[Channel (auto when only one is configured)]" "--account[Account id (accountId)]" "--json[Output JSON]" "--query[Optional search query]" "--limit[Limit results]"
}
_openclaw_directory_groups_members () {
	_arguments -C "--group-id[Group id]" "--channel[Channel (auto when only one is configured)]" "--account[Account id (accountId)]" "--json[Output JSON]" "--limit[Limit results]"
}
_openclaw_directory_peers () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'list[List peers]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(list) _openclaw_directory_peers_list ;;
			esac ;;
	esac
}
_openclaw_directory_peers_list () {
	_arguments -C "--channel[Channel (auto when only one is configured)]" "--account[Account id (accountId)]" "--json[Output JSON]" "--query[Optional search query]" "--limit[Limit results]"
}
_openclaw_directory_self () {
	_arguments -C "--channel[Channel (auto when only one is configured)]" "--account[Account id (accountId)]" "--json[Output JSON]"
}
_openclaw_dns () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'setup[Set up CoreDNS to serve your discovery domain for unicast DNS-SD (Wide-Area Bonjour)]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(setup) _openclaw_dns_setup ;;
			esac ;;
	esac
}
_openclaw_dns_setup () {
	_arguments -C "--domain[Wide-area discovery domain (e.g. openclaw.internal)]" "--apply[Install/update CoreDNS config and (re)start the service (requires sudo)]"
}
_openclaw_docs () {
	_arguments -C
}
_openclaw_doctor () {
	_arguments -C "--no-workspace-suggestions[Disable workspace memory system suggestions]" "--yes[Accept defaults without prompting]" "--repair[Apply recommended repairs without prompting]" "--fix[Apply recommended repairs (alias for --repair)]" "--force[Apply aggressive repairs (overwrites custom service config)]" "--non-interactive[Run without prompts (safe migrations only)]" "--generate-gateway-token[Generate and configure a gateway token]" "--deep[Scan system services for extra gateway installs]" "--lint[Run read-only health checks and report findings]" "--json[With --lint: emit JSON findings instead of human output]" "--severity-min[With --lint: drop findings below this severity (info|warning|error)]" "--skip[With --lint: skip a specific check id (repeatable)]" "--only[With --lint: run only the specified check id (repeatable)]"
}
_openclaw_exec_policy () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'show[Show the local config policy, host approvals, and effective merge]' 'preset[Apply a synchronized preset: "yolo", "cautious", or "deny-all"]' 'set[Synchronize local config and host approvals using explicit values]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(show) _openclaw_exec_policy_show ;;
				(preset) _openclaw_exec_policy_preset ;;
				(set) _openclaw_exec_policy_set ;;
			esac ;;
	esac
}
_openclaw_exec_policy_preset () {
	_arguments -C "--json[Output as JSON]"
}
_openclaw_exec_policy_set () {
	_arguments -C "--host[Exec host target: auto|sandbox|gateway|node]" "--security[Exec security: deny|allowlist|full]" "--ask[Exec ask mode: off|on-miss|always]" "--ask-fallback[Host approvals fallback: deny|allowlist|full]" "--json[Output as JSON]"
}
_openclaw_exec_policy_show () {
	_arguments -C "--json[Output as JSON]"
}
_openclaw_gateway () {
	local -a commands
	local -a options
	_arguments -C "--port[Port for the gateway WebSocket]" "--bind[Bind mode (\"loopback\"|\"lan\"|\"tailnet\"|\"auto\"|\"custom\"). Defaults to config gateway.bind (or loopback).]" "--token[Shared token required in connect.params.auth.token (default: OPENCLAW_GATEWAY_TOKEN env if set)]" "--auth[Gateway auth mode (\"none\"|\"token\"|\"password\"|\"trusted-proxy\")]" "--password[Password for auth mode=password]" "--password-file[Read gateway password from file]" "--tailscale[Tailscale exposure mode (\"off\"|\"serve\"|\"funnel\")]" "--tailscale-reset-on-exit[Reset Tailscale serve/funnel configuration on shutdown]" "--allow-unconfigured[Allow gateway start without enforcing gateway.mode=local in config (does not repair config)]" "--dev[Create a dev config + workspace if missing (no BOOTSTRAP.md)]" "--reset[Reset dev config + credentials + sessions + workspace (requires --dev)]" "--force[Kill any existing listener on the target port before starting]" "--verbose[Verbose logging to stdout/stderr]" "--cli-backend-logs[Only show CLI backend logs in the console (includes stdout/stderr)]" "--claude-cli-logs[Deprecated alias for --cli-backend-logs]" "--ws-log[WebSocket log style (\"auto\"|\"full\"|\"compact\")]" "--compact[Alias for \"--ws-log compact\"]" "--raw-stream[Log raw model stream events to jsonl]" "--raw-stream-path[Raw stream jsonl path]" "1: :_values 'command' 'run[Run the WebSocket Gateway (foreground)]' 'status[Show gateway service status + probe connectivity/capability]' 'install[Install the Gateway service (launchd/systemd/schtasks)]' 'uninstall[Uninstall the Gateway service (launchd/systemd/schtasks)]' 'start[Start the Gateway service (launchd/systemd/schtasks)]' 'stop[Stop the Gateway service (launchd/systemd/schtasks)]' 'restart[Restart the Gateway service (launchd/systemd/schtasks)]' 'call[Call a Gateway method]' 'usage-cost[Fetch usage cost summary from session logs]' 'health[Fetch Gateway health]' 'stability[Fetch payload-free Gateway stability diagnostics]' 'diagnostics[Export local support diagnostics]' 'probe[Show gateway reachability, auth capability, and read-probe summary (local + remote)]' 'discover[Discover gateways via Bonjour (local + wide-area if configured)]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(run) _openclaw_gateway_run ;;
				(status) _openclaw_gateway_status ;;
				(install) _openclaw_gateway_install ;;
				(uninstall) _openclaw_gateway_uninstall ;;
				(start) _openclaw_gateway_start ;;
				(stop) _openclaw_gateway_stop ;;
				(restart) _openclaw_gateway_restart ;;
				(call) _openclaw_gateway_call ;;
				(usage-cost) _openclaw_gateway_usage_cost ;;
				(health) _openclaw_gateway_health ;;
				(stability) _openclaw_gateway_stability ;;
				(diagnostics) _openclaw_gateway_diagnostics ;;
				(probe) _openclaw_gateway_probe ;;
				(discover) _openclaw_gateway_discover ;;
			esac ;;
	esac
}
_openclaw_gateway_call () {
	_arguments -C "--params[JSON object string for params]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--password[Gateway password (password auth)]" "--timeout[Timeout in ms]" "--expect-final[Wait for final response (agent)]" "--json[Output JSON]"
}
_openclaw_gateway_diagnostics () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'export[Write a shareable, payload-free diagnostics .zip]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(export) _openclaw_gateway_diagnostics_export ;;
			esac ;;
	esac
}
_openclaw_gateway_diagnostics_export () {
	_arguments -C "--output[Output .zip path]" "--log-lines[Maximum sanitized log lines to include]" "--log-bytes[Maximum log bytes to inspect]" "--url[Gateway WebSocket URL for health snapshot]" "--token[Gateway token for health snapshot]" "--password[Gateway password for health snapshot]" "--timeout[Status/health snapshot timeout in ms]" "--no-stability-bundle[Skip persisted stability bundle lookup]" "--json[Output JSON]"
}
_openclaw_gateway_discover () {
	_arguments -C "--timeout[Per-command timeout in ms]" "--json[Output JSON]"
}
_openclaw_gateway_health () {
	_arguments -C "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--password[Gateway password (password auth)]" "--timeout[Timeout in ms]" "--expect-final[Wait for final response (agent)]" "--json[Output JSON]"
}
_openclaw_gateway_install () {
	_arguments -C "--port[Gateway port]" "--runtime[Daemon runtime (node|bun). Default: node]" "--token[Gateway token (token auth)]" "--wrapper[Executable wrapper for generated service ProgramArguments]" "--force[Reinstall/overwrite if already installed]" "--json[Output JSON]"
}
_openclaw_gateway_probe () {
	_arguments -C "--url[Explicit Gateway WebSocket URL (still probes localhost)]" "--ssh[SSH target for remote gateway tunnel (user@host or user@host:port)]" "--ssh-identity[SSH identity file path]" "--ssh-auto[Try to derive an SSH target from Bonjour discovery]" "--token[Gateway token (applies to all probes)]" "--password[Gateway password (applies to all probes)]" "--timeout[Overall probe budget in ms]" "--json[Output JSON]"
}
_openclaw_gateway_restart () {
	_arguments -C "--force[Restart immediately without waiting for active gateway work]" "--safe[Request an OpenClaw-aware restart after active work drains]" "--skip-deferral[Bypass the safe-restart deferral gate; requires --safe]" "--wait[Wait duration before forcing restart (ms, 10s, 5m; 0 waits indefinitely)]" "--json[Output JSON]"
}
_openclaw_gateway_run () {
	_arguments -C "--port[Port for the gateway WebSocket]" "--bind[Bind mode (\"loopback\"|\"lan\"|\"tailnet\"|\"auto\"|\"custom\"). Defaults to config gateway.bind (or loopback).]" "--token[Shared token required in connect.params.auth.token (default: OPENCLAW_GATEWAY_TOKEN env if set)]" "--auth[Gateway auth mode (\"none\"|\"token\"|\"password\"|\"trusted-proxy\")]" "--password[Password for auth mode=password]" "--password-file[Read gateway password from file]" "--tailscale[Tailscale exposure mode (\"off\"|\"serve\"|\"funnel\")]" "--tailscale-reset-on-exit[Reset Tailscale serve/funnel configuration on shutdown]" "--allow-unconfigured[Allow gateway start without enforcing gateway.mode=local in config (does not repair config)]" "--dev[Create a dev config + workspace if missing (no BOOTSTRAP.md)]" "--reset[Reset dev config + credentials + sessions + workspace (requires --dev)]" "--force[Kill any existing listener on the target port before starting]" "--verbose[Verbose logging to stdout/stderr]" "--cli-backend-logs[Only show CLI backend logs in the console (includes stdout/stderr)]" "--claude-cli-logs[Deprecated alias for --cli-backend-logs]" "--ws-log[WebSocket log style (\"auto\"|\"full\"|\"compact\")]" "--compact[Alias for \"--ws-log compact\"]" "--raw-stream[Log raw model stream events to jsonl]" "--raw-stream-path[Raw stream jsonl path]"
}
_openclaw_gateway_stability () {
	_arguments -C "--limit[Maximum number of recent events]" "--type[Filter by diagnostic event type]" "--since-seq[Only include events after this sequence]" "--bundle[Read a persisted stability bundle instead of calling Gateway; pass \"latest\" for newest]" "--export[Write a shareable support diagnostics export]" "--output[Diagnostics export output .zip path]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--password[Gateway password (password auth)]" "--timeout[Timeout in ms]" "--expect-final[Wait for final response (agent)]" "--json[Output JSON]"
}
_openclaw_gateway_start () {
	_arguments -C "--json[Output JSON]"
}
_openclaw_gateway_status () {
	_arguments -C "--url[Gateway WebSocket URL (defaults to config/remote/local)]" "--token[Gateway token (if required)]" "--password[Gateway password (password auth)]" "--timeout[Timeout in ms]" "--no-probe[Skip RPC probe]" "--require-rpc[Exit non-zero when the RPC probe fails]" "--deep[Scan system-level services]" "--json[Output JSON]"
}
_openclaw_gateway_stop () {
	_arguments -C "--json[Output JSON]" "--disable[Persistently suppress KeepAlive/RunAtLoad so the gateway does not respawn until next start (launchd only)]"
}
_openclaw_gateway_uninstall () {
	_arguments -C "--json[Output JSON]"
}
_openclaw_gateway_usage_cost () {
	_arguments -C "--days[Number of days to include]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--password[Gateway password (password auth)]" "--timeout[Timeout in ms]" "--expect-final[Wait for final response (agent)]" "--json[Output JSON]"
}
_openclaw_health () {
	_arguments -C "--json[Output JSON instead of text]" "--timeout[Connection timeout in milliseconds]" "--verbose[Verbose logging]" "--debug[Alias for --verbose]"
}
_openclaw_hooks () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'list[List all hooks]' 'info[Show detailed information about a hook]' 'check[Check hooks eligibility status]' 'enable[Enable a hook]' 'disable[Disable a hook]' 'relay[Internal native harness hook relay]' 'install[Deprecated: install a hook pack via `openclaw plugins install`]' 'update[Deprecated: update hook packs via `openclaw plugins update`]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(list) _openclaw_hooks_list ;;
				(info) _openclaw_hooks_info ;;
				(check) _openclaw_hooks_check ;;
				(enable) _openclaw_hooks_enable ;;
				(disable) _openclaw_hooks_disable ;;
				(relay) _openclaw_hooks_relay ;;
				(install) _openclaw_hooks_install ;;
				(update) _openclaw_hooks_update ;;
			esac ;;
	esac
}
_openclaw_hooks_check () {
	_arguments -C "--json[Output as JSON]"
}
_openclaw_hooks_disable () {
	_arguments -C
}
_openclaw_hooks_enable () {
	_arguments -C
}
_openclaw_hooks_info () {
	_arguments -C "--json[Output as JSON]"
}
_openclaw_hooks_install () {
	_arguments -C "(--link -l)"{--link,-l}"[Link a local path instead of copying]" "--pin[Record npm installs as exact resolved <name>@<version>]"
}
_openclaw_hooks_list () {
	_arguments -C "--eligible[Show only eligible hooks]" "--json[Output as JSON]" "(--verbose -v)"{--verbose,-v}"[Show more details including missing requirements]"
}
_openclaw_hooks_relay () {
	_arguments -C "--provider[Native harness provider]" "--relay-id[Native hook relay id]" "--event[Native hook event]" "--timeout[Gateway timeout in ms]"
}
_openclaw_hooks_update () {
	_arguments -C "--all[Update all tracked hooks]" "--dry-run[Show what would change without writing]"
}
_openclaw_infer () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'list[List canonical capability ids and supported transports]' 'inspect[Inspect one canonical capability id]' 'model[Text inference and model catalog commands]' 'image[Image generation and description]' 'audio[Audio transcription]' 'tts[Text to speech]' 'video[Video generation and description]' 'web[Web capabilities]' 'embedding[Embedding providers]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(list) _openclaw_infer_list ;;
				(inspect) _openclaw_infer_inspect ;;
				(model) _openclaw_infer_model ;;
				(image) _openclaw_infer_image ;;
				(audio) _openclaw_infer_audio ;;
				(tts) _openclaw_infer_tts ;;
				(video) _openclaw_infer_video ;;
				(web) _openclaw_infer_web ;;
				(embedding) _openclaw_infer_embedding ;;
			esac ;;
	esac
}
_openclaw_infer_audio () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'transcribe[Transcribe one audio file]' 'providers[List audio transcription providers]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(transcribe) _openclaw_infer_audio_transcribe ;;
				(providers) _openclaw_infer_audio_providers ;;
			esac ;;
	esac
}
_openclaw_infer_audio_providers () {
	_arguments -C "--json[Output JSON]"
}
_openclaw_infer_audio_transcribe () {
	_arguments -C "--file[Audio file]" "--language[Language hint]" "--prompt[Prompt hint]" "--model[Model override]" "--json[Output JSON]"
}
_openclaw_infer_embedding () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'create[Create embeddings]' 'providers[List embedding providers]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(create) _openclaw_infer_embedding_create ;;
				(providers) _openclaw_infer_embedding_providers ;;
			esac ;;
	esac
}
_openclaw_infer_embedding_create () {
	_arguments -C "--text[Input text]" "--provider[Provider id]" "--model[Model override]" "--json[Output JSON]"
}
_openclaw_infer_embedding_providers () {
	_arguments -C "--json[Output JSON]"
}
_openclaw_infer_image () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'generate[Generate images]' 'edit[Edit images with one or more input files]' 'describe[Describe one image file]' 'describe-many[Describe multiple image files]' 'providers[List image generation providers]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(generate) _openclaw_infer_image_generate ;;
				(edit) _openclaw_infer_image_edit ;;
				(describe) _openclaw_infer_image_describe ;;
				(describe-many) _openclaw_infer_image_describe_many ;;
				(providers) _openclaw_infer_image_providers ;;
			esac ;;
	esac
}
_openclaw_infer_image_describe () {
	_arguments -C "--file[Image file]" "--prompt[Prompt hint]" "--model[Model override]" "--timeout-ms[Provider request timeout in milliseconds]" "--json[Output JSON]"
}
_openclaw_infer_image_describe_many () {
	_arguments -C "--file[Image file]" "--prompt[Prompt hint]" "--model[Model override]" "--timeout-ms[Provider request timeout in milliseconds]" "--json[Output JSON]"
}
_openclaw_infer_image_edit () {
	_arguments -C "--file[Input file]" "--prompt[Prompt text]" "--model[Model override]" "--size[Size hint like 1024x1024]" "--aspect-ratio[Aspect ratio hint like 16:9]" "--resolution[Resolution hint: 1K, 2K, or 4K]" "--output-format[Output format hint: png, jpeg, or webp]" "--background[Background hint: transparent, opaque, or auto]" "--openai-background[OpenAI background hint: transparent, opaque, or auto]" "--timeout-ms[Provider request timeout in milliseconds]" "--output[Output path]" "--json[Output JSON]"
}
_openclaw_infer_image_generate () {
	_arguments -C "--prompt[Prompt text]" "--model[Model override]" "--count[Number of images]" "--size[Size hint like 1024x1024]" "--aspect-ratio[Aspect ratio hint like 16:9]" "--resolution[Resolution hint: 1K, 2K, or 4K]" "--output-format[Output format hint: png, jpeg, or webp]" "--background[Background hint: transparent, opaque, or auto]" "--openai-background[OpenAI background hint: transparent, opaque, or auto]" "--timeout-ms[Provider request timeout in milliseconds]" "--output[Output path]" "--json[Output JSON]"
}
_openclaw_infer_image_providers () {
	_arguments -C "--json[Output JSON]"
}
_openclaw_infer_inspect () {
	_arguments -C "--name[Capability id]" "--json[Output JSON]"
}
_openclaw_infer_list () {
	_arguments -C "--json[Output JSON]"
}
_openclaw_infer_model () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'run[Run a one-shot model turn]' 'list[List known models]' 'inspect[Inspect one model catalog entry]' 'providers[List model providers from the catalog]' 'auth[Provider auth helpers]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(run) _openclaw_infer_model_run ;;
				(list) _openclaw_infer_model_list ;;
				(inspect) _openclaw_infer_model_inspect ;;
				(providers) _openclaw_infer_model_providers ;;
				(auth) _openclaw_infer_model_auth ;;
			esac ;;
	esac
}
_openclaw_infer_model_auth () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'login[Run provider auth login]' 'logout[Remove saved auth profiles for one provider]' 'status[Show configured auth state]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(login) _openclaw_infer_model_auth_login ;;
				(logout) _openclaw_infer_model_auth_logout ;;
				(status) _openclaw_infer_model_auth_status ;;
			esac ;;
	esac
}
_openclaw_infer_model_auth_login () {
	_arguments -C "--provider[Provider id]" "--method[Provider auth method id]"
}
_openclaw_infer_model_auth_logout () {
	_arguments -C "--provider[Provider id]" "--agent[Agent id (default: configured default agent)]" "--json[Output JSON]"
}
_openclaw_infer_model_auth_status () {
	_arguments -C "--json[Output JSON]"
}
_openclaw_infer_model_inspect () {
	_arguments -C "--model[Model id]" "--json[Output JSON]"
}
_openclaw_infer_model_list () {
	_arguments -C "--json[Output JSON]"
}
_openclaw_infer_model_providers () {
	_arguments -C "--json[Output JSON]"
}
_openclaw_infer_model_run () {
	_arguments -C "--prompt[Prompt text]" "--file[Image file]" "--model[Model override]" "--thinking[Thinking level override]" "--local[Force local execution]" "--gateway[Force gateway execution]" "--json[Output JSON]"
}
_openclaw_infer_tts () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'convert[Convert text to speech]' 'voices[List voices for a TTS provider]' 'providers[List speech providers]' 'personas[List TTS personas]' 'status[Show TTS status]' 'enable[Enable TTS]' 'disable[Disable TTS]' 'set-provider[Set the active TTS provider]' 'set-persona[Set the active TTS persona]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(convert) _openclaw_infer_tts_convert ;;
				(voices) _openclaw_infer_tts_voices ;;
				(providers) _openclaw_infer_tts_providers ;;
				(personas) _openclaw_infer_tts_personas ;;
				(status) _openclaw_infer_tts_status ;;
				(enable) _openclaw_infer_tts_enable ;;
				(disable) _openclaw_infer_tts_disable ;;
				(set-provider) _openclaw_infer_tts_set_provider ;;
				(set-persona) _openclaw_infer_tts_set_persona ;;
			esac ;;
	esac
}
_openclaw_infer_tts_convert () {
	_arguments -C "--text[Input text]" "--channel[Channel hint]" "--voice[Voice hint]" "--model[Model override]" "--output[Output path]" "--local[Force local execution]" "--gateway[Force gateway execution]" "--json[Output JSON]"
}
_openclaw_infer_tts_disable () {
	_arguments -C "--local[Force local execution]" "--gateway[Force gateway execution]" "--json[Output JSON]"
}
_openclaw_infer_tts_enable () {
	_arguments -C "--local[Force local execution]" "--gateway[Force gateway execution]" "--json[Output JSON]"
}
_openclaw_infer_tts_personas () {
	_arguments -C "--local[Force local execution]" "--gateway[Force gateway execution]" "--json[Output JSON]"
}
_openclaw_infer_tts_providers () {
	_arguments -C "--local[Force local execution]" "--gateway[Force gateway execution]" "--json[Output JSON]"
}
_openclaw_infer_tts_set_persona () {
	_arguments -C "--persona[TTS persona id]" "--off[Disable the active TTS persona]" "--local[Force local execution]" "--gateway[Force gateway execution]" "--json[Output JSON]"
}
_openclaw_infer_tts_set_provider () {
	_arguments -C "--provider[Speech provider id]" "--local[Force local execution]" "--gateway[Force gateway execution]" "--json[Output JSON]"
}
_openclaw_infer_tts_status () {
	_arguments -C "--gateway[Force gateway execution]" "--json[Output JSON]"
}
_openclaw_infer_tts_voices () {
	_arguments -C "--provider[Speech provider id]" "--json[Output JSON]"
}
_openclaw_infer_video () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'generate[Generate video]' 'describe[Describe one video file]' 'providers[List video generation and description providers]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(generate) _openclaw_infer_video_generate ;;
				(describe) _openclaw_infer_video_describe ;;
				(providers) _openclaw_infer_video_providers ;;
			esac ;;
	esac
}
_openclaw_infer_video_describe () {
	_arguments -C "--file[Video file]" "--model[Model override]" "--json[Output JSON]"
}
_openclaw_infer_video_generate () {
	_arguments -C "--prompt[Prompt text]" "--model[Model override]" "--size[Size hint like 1280x720]" "--aspect-ratio[Aspect ratio hint like 16:9]" "--resolution[Resolution hint: 480P, 720P, 768P, or 1080P]" "--duration[Target duration in seconds]" "--audio[Enable generated audio when supported]" "--watermark[Request provider watermark when supported]" "--timeout-ms[Provider request timeout in milliseconds]" "--output[Output path]" "--json[Output JSON]"
}
_openclaw_infer_video_providers () {
	_arguments -C "--json[Output JSON]"
}
_openclaw_infer_web () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'search[Run web search]' 'fetch[Fetch one URL]' 'providers[List web providers]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(search) _openclaw_infer_web_search ;;
				(fetch) _openclaw_infer_web_fetch ;;
				(providers) _openclaw_infer_web_providers ;;
			esac ;;
	esac
}
_openclaw_infer_web_fetch () {
	_arguments -C "--url[URL]" "--provider[Provider id]" "--format[Format hint]" "--json[Output JSON]"
}
_openclaw_infer_web_providers () {
	_arguments -C "--json[Output JSON]"
}
_openclaw_infer_web_search () {
	_arguments -C "--query[Search query]" "--provider[Provider id]" "--limit[Result limit]" "--json[Output JSON]"
}
_openclaw_logs () {
	_arguments -C "--limit[Max lines to return]" "--max-bytes[Max bytes to read]" "--follow[Follow log output]" "--interval[Polling interval in ms]" "--json[Emit JSON log lines]" "--plain[Plain text output (no ANSI styling)]" "--no-color[Disable ANSI colors]" "--local-time[Display timestamps in local timezone]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--expect-final[Wait for final response (agent)]"
}
_openclaw_mcp () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'serve[Expose OpenClaw channels over MCP stdio]' 'list[List configured MCP servers]' 'show[Show one configured MCP server or the full MCP config]' 'set[Set one configured MCP server from a JSON object]' 'unset[Remove one configured MCP server]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(serve) _openclaw_mcp_serve ;;
				(list) _openclaw_mcp_list ;;
				(show) _openclaw_mcp_show ;;
				(set) _openclaw_mcp_set ;;
				(unset) _openclaw_mcp_unset ;;
			esac ;;
	esac
}
_openclaw_mcp_list () {
	_arguments -C "--json[Print JSON]"
}
_openclaw_mcp_serve () {
	_arguments -C "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--token-file[Read gateway token from file]" "--password[Gateway password (if required)]" "--password-file[Read gateway password from file]" "--claude-channel-mode[Claude channel notification mode: auto, on, or off]" "(--verbose -v)"{--verbose,-v}"[Verbose logging to stderr]"
}
_openclaw_mcp_set () {
	_arguments -C
}
_openclaw_mcp_show () {
	_arguments -C "--json[Print JSON]"
}
_openclaw_mcp_unset () {
	_arguments -C
}
_openclaw_message () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'send[Send a message]' 'broadcast[Broadcast a message to multiple targets]' 'poll[Send a poll]' 'react[Add or remove a reaction]' 'reactions[List reactions on a message]' 'read[Read recent messages]' 'edit[Edit a message]' 'delete[Delete a message]' 'pin[Pin a message]' 'unpin[Unpin a message]' 'pins[List pinned messages]' 'permissions[Fetch channel permissions]' 'search[Search Discord messages]' 'thread[Thread actions]' 'emoji[Emoji actions]' 'sticker[Sticker actions]' 'role[Role actions]' 'channel[Channel actions]' 'member[Member actions]' 'voice[Voice actions]' 'event[Event actions]' 'timeout[Timeout a member]' 'kick[Kick a member]' 'ban[Ban a member]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(send) _openclaw_message_send ;;
				(broadcast) _openclaw_message_broadcast ;;
				(poll) _openclaw_message_poll ;;
				(react) _openclaw_message_react ;;
				(reactions) _openclaw_message_reactions ;;
				(read) _openclaw_message_read ;;
				(edit) _openclaw_message_edit ;;
				(delete) _openclaw_message_delete ;;
				(pin) _openclaw_message_pin ;;
				(unpin) _openclaw_message_unpin ;;
				(pins) _openclaw_message_pins ;;
				(permissions) _openclaw_message_permissions ;;
				(search) _openclaw_message_search ;;
				(thread) _openclaw_message_thread ;;
				(emoji) _openclaw_message_emoji ;;
				(sticker) _openclaw_message_sticker ;;
				(role) _openclaw_message_role ;;
				(channel) _openclaw_message_channel ;;
				(member) _openclaw_message_member ;;
				(voice) _openclaw_message_voice ;;
				(event) _openclaw_message_event ;;
				(timeout) _openclaw_message_timeout ;;
				(kick) _openclaw_message_kick ;;
				(ban) _openclaw_message_ban ;;
			esac ;;
	esac
}
_openclaw_message_ban () {
	_arguments -C "--guild-id[Guild id]" "--user-id[User id]" "--channel[Channel: telegram|whatsapp|discord|irc|googlechat|slack|signal|imessage|feishu|nostr|msteams|mattermost|nextcloud-talk|matrix|line|zalo|clickclack|zalouser|synology-chat|tlon|qa-channel|qqbot|twitch]" "--account[Channel account id (accountId)]" "--json[Output result as JSON]" "--dry-run[Print payload and skip sending]" "--verbose[Verbose logging]" "--reason[Moderation reason]" "--delete-days[Ban delete message days]"
}
_openclaw_message_broadcast () {
	_arguments -C "--channel[Channel: telegram|whatsapp|discord|irc|googlechat|slack|signal|imessage|feishu|nostr|msteams|mattermost|nextcloud-talk|matrix|line|zalo|clickclack|zalouser|synology-chat|tlon|qa-channel|qqbot|twitch]" "--account[Channel account id (accountId)]" "--json[Output result as JSON]" "--dry-run[Print payload and skip sending]" "--verbose[Verbose logging]" "--targets[Recipient/channel targets (same format as --target); accepts ids or names when the directory is available.]" "--message[Message to send]" "--media[Media URL]"
}
_openclaw_message_channel () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'info[Fetch channel info]' 'list[List channels]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(info) _openclaw_message_channel_info ;;
				(list) _openclaw_message_channel_list ;;
			esac ;;
	esac
}
_openclaw_message_channel_info () {
	_arguments -C "(--target -t)"{--target,-t}"[Recipient/channel: E.164 for WhatsApp/Signal, Telegram chat id/@username, Discord/Slack/Mattermost <channelId|user:ID|channel:ID>, or iMessage handle/chat_id]" "--channel[Channel: telegram|whatsapp|discord|irc|googlechat|slack|signal|imessage|feishu|nostr|msteams|mattermost|nextcloud-talk|matrix|line|zalo|clickclack|zalouser|synology-chat|tlon|qa-channel|qqbot|twitch]" "--account[Channel account id (accountId)]" "--json[Output result as JSON]" "--dry-run[Print payload and skip sending]" "--verbose[Verbose logging]"
}
_openclaw_message_channel_list () {
	_arguments -C "--guild-id[Guild id]" "--channel[Channel: telegram|whatsapp|discord|irc|googlechat|slack|signal|imessage|feishu|nostr|msteams|mattermost|nextcloud-talk|matrix|line|zalo|clickclack|zalouser|synology-chat|tlon|qa-channel|qqbot|twitch]" "--account[Channel account id (accountId)]" "--json[Output result as JSON]" "--dry-run[Print payload and skip sending]" "--verbose[Verbose logging]"
}
_openclaw_message_delete () {
	_arguments -C "--message-id[Message id]" "(--target -t)"{--target,-t}"[Recipient/channel: E.164 for WhatsApp/Signal, Telegram chat id/@username, Discord/Slack/Mattermost <channelId|user:ID|channel:ID>, or iMessage handle/chat_id]" "--channel[Channel: telegram|whatsapp|discord|irc|googlechat|slack|signal|imessage|feishu|nostr|msteams|mattermost|nextcloud-talk|matrix|line|zalo|clickclack|zalouser|synology-chat|tlon|qa-channel|qqbot|twitch]" "--account[Channel account id (accountId)]" "--json[Output result as JSON]" "--dry-run[Print payload and skip sending]" "--verbose[Verbose logging]"
}
_openclaw_message_edit () {
	_arguments -C "--message-id[Message id]" "(--message -m)"{--message,-m}"[Message body]" "(--target -t)"{--target,-t}"[Recipient/channel: E.164 for WhatsApp/Signal, Telegram chat id/@username, Discord/Slack/Mattermost <channelId|user:ID|channel:ID>, or iMessage handle/chat_id]" "--channel[Channel: telegram|whatsapp|discord|irc|googlechat|slack|signal|imessage|feishu|nostr|msteams|mattermost|nextcloud-talk|matrix|line|zalo|clickclack|zalouser|synology-chat|tlon|qa-channel|qqbot|twitch]" "--account[Channel account id (accountId)]" "--json[Output result as JSON]" "--dry-run[Print payload and skip sending]" "--verbose[Verbose logging]" "--thread-id[Thread id (Telegram forum thread)]"
}
_openclaw_message_emoji () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'list[List emojis]' 'upload[Upload an emoji]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(list) _openclaw_message_emoji_list ;;
				(upload) _openclaw_message_emoji_upload ;;
			esac ;;
	esac
}
_openclaw_message_emoji_list () {
	_arguments -C "--channel[Channel: telegram|whatsapp|discord|irc|googlechat|slack|signal|imessage|feishu|nostr|msteams|mattermost|nextcloud-talk|matrix|line|zalo|clickclack|zalouser|synology-chat|tlon|qa-channel|qqbot|twitch]" "--account[Channel account id (accountId)]" "--json[Output result as JSON]" "--dry-run[Print payload and skip sending]" "--verbose[Verbose logging]" "--guild-id[Guild id (Discord)]"
}
_openclaw_message_emoji_upload () {
	_arguments -C "--guild-id[Guild id]" "--channel[Channel: telegram|whatsapp|discord|irc|googlechat|slack|signal|imessage|feishu|nostr|msteams|mattermost|nextcloud-talk|matrix|line|zalo|clickclack|zalouser|synology-chat|tlon|qa-channel|qqbot|twitch]" "--account[Channel account id (accountId)]" "--json[Output result as JSON]" "--dry-run[Print payload and skip sending]" "--verbose[Verbose logging]" "--emoji-name[Emoji name]" "--media[Emoji media (path or URL)]" "--role-ids[Role id (repeat)]"
}
_openclaw_message_event () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'list[List scheduled events]' 'create[Create a scheduled event]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(list) _openclaw_message_event_list ;;
				(create) _openclaw_message_event_create ;;
			esac ;;
	esac
}
_openclaw_message_event_create () {
	_arguments -C "--guild-id[Guild id]" "--event-name[Event name]" "--start-time[Event start time]" "--channel[Channel: telegram|whatsapp|discord|irc|googlechat|slack|signal|imessage|feishu|nostr|msteams|mattermost|nextcloud-talk|matrix|line|zalo|clickclack|zalouser|synology-chat|tlon|qa-channel|qqbot|twitch]" "--account[Channel account id (accountId)]" "--json[Output result as JSON]" "--dry-run[Print payload and skip sending]" "--verbose[Verbose logging]" "--end-time[Event end time]" "--desc[Event description]" "--channel-id[Channel id]" "--location[Event location]" "--event-type[Event type]" "--image[Cover image URL or local file path]"
}
_openclaw_message_event_list () {
	_arguments -C "--guild-id[Guild id]" "--channel[Channel: telegram|whatsapp|discord|irc|googlechat|slack|signal|imessage|feishu|nostr|msteams|mattermost|nextcloud-talk|matrix|line|zalo|clickclack|zalouser|synology-chat|tlon|qa-channel|qqbot|twitch]" "--account[Channel account id (accountId)]" "--json[Output result as JSON]" "--dry-run[Print payload and skip sending]" "--verbose[Verbose logging]"
}
_openclaw_message_kick () {
	_arguments -C "--guild-id[Guild id]" "--user-id[User id]" "--channel[Channel: telegram|whatsapp|discord|irc|googlechat|slack|signal|imessage|feishu|nostr|msteams|mattermost|nextcloud-talk|matrix|line|zalo|clickclack|zalouser|synology-chat|tlon|qa-channel|qqbot|twitch]" "--account[Channel account id (accountId)]" "--json[Output result as JSON]" "--dry-run[Print payload and skip sending]" "--verbose[Verbose logging]" "--reason[Moderation reason]"
}
_openclaw_message_member () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'info[Fetch member info]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(info) _openclaw_message_member_info ;;
			esac ;;
	esac
}
_openclaw_message_member_info () {
	_arguments -C "--user-id[User id]" "--channel[Channel: telegram|whatsapp|discord|irc|googlechat|slack|signal|imessage|feishu|nostr|msteams|mattermost|nextcloud-talk|matrix|line|zalo|clickclack|zalouser|synology-chat|tlon|qa-channel|qqbot|twitch]" "--account[Channel account id (accountId)]" "--json[Output result as JSON]" "--dry-run[Print payload and skip sending]" "--verbose[Verbose logging]" "--guild-id[Guild id (Discord)]"
}
_openclaw_message_permissions () {
	_arguments -C "(--target -t)"{--target,-t}"[Recipient/channel: E.164 for WhatsApp/Signal, Telegram chat id/@username, Discord/Slack/Mattermost <channelId|user:ID|channel:ID>, or iMessage handle/chat_id]" "--channel[Channel: telegram|whatsapp|discord|irc|googlechat|slack|signal|imessage|feishu|nostr|msteams|mattermost|nextcloud-talk|matrix|line|zalo|clickclack|zalouser|synology-chat|tlon|qa-channel|qqbot|twitch]" "--account[Channel account id (accountId)]" "--json[Output result as JSON]" "--dry-run[Print payload and skip sending]" "--verbose[Verbose logging]"
}
_openclaw_message_pin () {
	_arguments -C "(--target -t)"{--target,-t}"[Recipient/channel: E.164 for WhatsApp/Signal, Telegram chat id/@username, Discord/Slack/Mattermost <channelId|user:ID|channel:ID>, or iMessage handle/chat_id]" "--channel[Channel: telegram|whatsapp|discord|irc|googlechat|slack|signal|imessage|feishu|nostr|msteams|mattermost|nextcloud-talk|matrix|line|zalo|clickclack|zalouser|synology-chat|tlon|qa-channel|qqbot|twitch]" "--account[Channel account id (accountId)]" "--json[Output result as JSON]" "--dry-run[Print payload and skip sending]" "--verbose[Verbose logging]" "--message-id[Message id]"
}
_openclaw_message_pins () {
	_arguments -C "(--target -t)"{--target,-t}"[Recipient/channel: E.164 for WhatsApp/Signal, Telegram chat id/@username, Discord/Slack/Mattermost <channelId|user:ID|channel:ID>, or iMessage handle/chat_id]" "--channel[Channel: telegram|whatsapp|discord|irc|googlechat|slack|signal|imessage|feishu|nostr|msteams|mattermost|nextcloud-talk|matrix|line|zalo|clickclack|zalouser|synology-chat|tlon|qa-channel|qqbot|twitch]" "--account[Channel account id (accountId)]" "--json[Output result as JSON]" "--dry-run[Print payload and skip sending]" "--verbose[Verbose logging]" "--limit[Result limit]"
}
_openclaw_message_poll () {
	_arguments -C "(--target -t)"{--target,-t}"[Recipient/channel: E.164 for WhatsApp/Signal, Telegram chat id/@username, Discord/Slack/Mattermost <channelId|user:ID|channel:ID>, or iMessage handle/chat_id]" "--channel[Channel: telegram|whatsapp|discord|irc|googlechat|slack|signal|imessage|feishu|nostr|msteams|mattermost|nextcloud-talk|matrix|line|zalo|clickclack|zalouser|synology-chat|tlon|qa-channel|qqbot|twitch]" "--account[Channel account id (accountId)]" "--json[Output result as JSON]" "--dry-run[Print payload and skip sending]" "--verbose[Verbose logging]" "--poll-question[Poll question]" "--poll-option[Poll option (repeat 2-12 times)]" "--poll-multi[Allow multiple selections]" "--poll-duration-hours[Poll duration in hours (Discord)]" "--poll-duration-seconds[Poll duration in seconds (Telegram; 5-600)]" "--poll-anonymous[Send an anonymous poll (Telegram)]" "--poll-public[Send a non-anonymous poll (Telegram)]" "(--message -m)"{--message,-m}"[Optional message body]" "--silent[Send poll silently without notification (Telegram + Discord where supported)]" "--thread-id[Thread id (Telegram forum topic / Slack thread ts)]"
}
_openclaw_message_react () {
	_arguments -C "(--target -t)"{--target,-t}"[Recipient/channel: E.164 for WhatsApp/Signal, Telegram chat id/@username, Discord/Slack/Mattermost <channelId|user:ID|channel:ID>, or iMessage handle/chat_id]" "--channel[Channel: telegram|whatsapp|discord|irc|googlechat|slack|signal|imessage|feishu|nostr|msteams|mattermost|nextcloud-talk|matrix|line|zalo|clickclack|zalouser|synology-chat|tlon|qa-channel|qqbot|twitch]" "--account[Channel account id (accountId)]" "--json[Output result as JSON]" "--dry-run[Print payload and skip sending]" "--verbose[Verbose logging]" "--message-id[Message id]" "--emoji[Emoji for reactions]" "--remove[Remove reaction]" "--participant[WhatsApp reaction participant]" "--from-me[WhatsApp reaction fromMe]" "--target-author[Signal reaction target author (uuid or phone)]" "--target-author-uuid[Signal reaction target author uuid]"
}
_openclaw_message_reactions () {
	_arguments -C "(--target -t)"{--target,-t}"[Recipient/channel: E.164 for WhatsApp/Signal, Telegram chat id/@username, Discord/Slack/Mattermost <channelId|user:ID|channel:ID>, or iMessage handle/chat_id]" "--channel[Channel: telegram|whatsapp|discord|irc|googlechat|slack|signal|imessage|feishu|nostr|msteams|mattermost|nextcloud-talk|matrix|line|zalo|clickclack|zalouser|synology-chat|tlon|qa-channel|qqbot|twitch]" "--account[Channel account id (accountId)]" "--json[Output result as JSON]" "--dry-run[Print payload and skip sending]" "--verbose[Verbose logging]" "--message-id[Message id]" "--limit[Result limit]"
}
_openclaw_message_read () {
	_arguments -C "(--target -t)"{--target,-t}"[Recipient/channel: E.164 for WhatsApp/Signal, Telegram chat id/@username, Discord/Slack/Mattermost <channelId|user:ID|channel:ID>, or iMessage handle/chat_id]" "--channel[Channel: telegram|whatsapp|discord|irc|googlechat|slack|signal|imessage|feishu|nostr|msteams|mattermost|nextcloud-talk|matrix|line|zalo|clickclack|zalouser|synology-chat|tlon|qa-channel|qqbot|twitch]" "--account[Channel account id (accountId)]" "--json[Output result as JSON]" "--dry-run[Print payload and skip sending]" "--verbose[Verbose logging]" "--limit[Result limit]" "--message-id[Read a specific message id]" "--before[Read/search before id]" "--after[Read/search after id]" "--around[Read around id]" "--thread-id[Thread id (Slack thread timestamp)]" "--include-thread[Include thread replies (Discord)]"
}
_openclaw_message_role () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'info[List roles]' 'add[Add role to a member]' 'remove[Remove role from a member]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(info) _openclaw_message_role_info ;;
				(add) _openclaw_message_role_add ;;
				(remove) _openclaw_message_role_remove ;;
			esac ;;
	esac
}
_openclaw_message_role_add () {
	_arguments -C "--guild-id[Guild id]" "--user-id[User id]" "--role-id[Role id]" "--channel[Channel: telegram|whatsapp|discord|irc|googlechat|slack|signal|imessage|feishu|nostr|msteams|mattermost|nextcloud-talk|matrix|line|zalo|clickclack|zalouser|synology-chat|tlon|qa-channel|qqbot|twitch]" "--account[Channel account id (accountId)]" "--json[Output result as JSON]" "--dry-run[Print payload and skip sending]" "--verbose[Verbose logging]"
}
_openclaw_message_role_info () {
	_arguments -C "--guild-id[Guild id]" "--channel[Channel: telegram|whatsapp|discord|irc|googlechat|slack|signal|imessage|feishu|nostr|msteams|mattermost|nextcloud-talk|matrix|line|zalo|clickclack|zalouser|synology-chat|tlon|qa-channel|qqbot|twitch]" "--account[Channel account id (accountId)]" "--json[Output result as JSON]" "--dry-run[Print payload and skip sending]" "--verbose[Verbose logging]"
}
_openclaw_message_role_remove () {
	_arguments -C "--guild-id[Guild id]" "--user-id[User id]" "--role-id[Role id]" "--channel[Channel: telegram|whatsapp|discord|irc|googlechat|slack|signal|imessage|feishu|nostr|msteams|mattermost|nextcloud-talk|matrix|line|zalo|clickclack|zalouser|synology-chat|tlon|qa-channel|qqbot|twitch]" "--account[Channel account id (accountId)]" "--json[Output result as JSON]" "--dry-run[Print payload and skip sending]" "--verbose[Verbose logging]"
}
_openclaw_message_search () {
	_arguments -C "--channel[Channel: telegram|whatsapp|discord|irc|googlechat|slack|signal|imessage|feishu|nostr|msteams|mattermost|nextcloud-talk|matrix|line|zalo|clickclack|zalouser|synology-chat|tlon|qa-channel|qqbot|twitch]" "--account[Channel account id (accountId)]" "--json[Output result as JSON]" "--dry-run[Print payload and skip sending]" "--verbose[Verbose logging]" "--guild-id[Guild id]" "--query[Search query]" "--channel-id[Channel id]" "--channel-ids[Channel id (repeat)]" "--author-id[Author id]" "--author-ids[Author id (repeat)]" "--limit[Result limit]"
}
_openclaw_message_send () {
	_arguments -C "(--message -m)"{--message,-m}"[Message body (required unless --media is set)]" "(--target -t)"{--target,-t}"[Recipient/channel: E.164 for WhatsApp/Signal, Telegram chat id/@username, Discord/Slack/Mattermost <channelId|user:ID|channel:ID>, or iMessage handle/chat_id]" "--media[Attach media (image/audio/video/document). Accepts local paths or URLs.]" "--presentation[Shared presentation payload as JSON (text, context, dividers, buttons, selects)]" "--delivery[Shared delivery preferences as JSON]" "--pin[Request that the delivered message be pinned when supported]" "--reply-to[Reply-to message id]" "--thread-id[Thread id (Telegram forum thread)]" "--gif-playback[Treat video media as GIF playback (WhatsApp only).]" "--force-document[Send media as document to avoid channel compression (Telegram, WhatsApp). Applies to images, GIFs, and videos.]" "--silent[Send message silently without notification (Telegram + Discord)]" "--channel[Channel: telegram|whatsapp|discord|irc|googlechat|slack|signal|imessage|feishu|nostr|msteams|mattermost|nextcloud-talk|matrix|line|zalo|clickclack|zalouser|synology-chat|tlon|qa-channel|qqbot|twitch]" "--account[Channel account id (accountId)]" "--json[Output result as JSON]" "--dry-run[Print payload and skip sending]" "--verbose[Verbose logging]"
}
_openclaw_message_sticker () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'send[Send stickers]' 'upload[Upload a sticker]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(send) _openclaw_message_sticker_send ;;
				(upload) _openclaw_message_sticker_upload ;;
			esac ;;
	esac
}
_openclaw_message_sticker_send () {
	_arguments -C "(--target -t)"{--target,-t}"[Recipient/channel: E.164 for WhatsApp/Signal, Telegram chat id/@username, Discord/Slack/Mattermost <channelId|user:ID|channel:ID>, or iMessage handle/chat_id]" "--channel[Channel: telegram|whatsapp|discord|irc|googlechat|slack|signal|imessage|feishu|nostr|msteams|mattermost|nextcloud-talk|matrix|line|zalo|clickclack|zalouser|synology-chat|tlon|qa-channel|qqbot|twitch]" "--account[Channel account id (accountId)]" "--json[Output result as JSON]" "--dry-run[Print payload and skip sending]" "--verbose[Verbose logging]" "--sticker-id[Sticker id (repeat)]" "(--message -m)"{--message,-m}"[Optional message body]"
}
_openclaw_message_sticker_upload () {
	_arguments -C "--guild-id[Guild id]" "--channel[Channel: telegram|whatsapp|discord|irc|googlechat|slack|signal|imessage|feishu|nostr|msteams|mattermost|nextcloud-talk|matrix|line|zalo|clickclack|zalouser|synology-chat|tlon|qa-channel|qqbot|twitch]" "--account[Channel account id (accountId)]" "--json[Output result as JSON]" "--dry-run[Print payload and skip sending]" "--verbose[Verbose logging]" "--sticker-name[Sticker name]" "--sticker-desc[Sticker description]" "--sticker-tags[Sticker tags]" "--media[Sticker media (path or URL)]"
}
_openclaw_message_thread () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'create[Create a thread]' 'list[List threads]' 'reply[Reply in a thread]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(create) _openclaw_message_thread_create ;;
				(list) _openclaw_message_thread_list ;;
				(reply) _openclaw_message_thread_reply ;;
			esac ;;
	esac
}
_openclaw_message_thread_create () {
	_arguments -C "--thread-name[Thread name]" "(--target -t)"{--target,-t}"[Recipient/channel: E.164 for WhatsApp/Signal, Telegram chat id/@username, Discord/Slack/Mattermost <channelId|user:ID|channel:ID>, or iMessage handle/chat_id]" "--channel[Channel: telegram|whatsapp|discord|irc|googlechat|slack|signal|imessage|feishu|nostr|msteams|mattermost|nextcloud-talk|matrix|line|zalo|clickclack|zalouser|synology-chat|tlon|qa-channel|qqbot|twitch]" "--account[Channel account id (accountId)]" "--json[Output result as JSON]" "--dry-run[Print payload and skip sending]" "--verbose[Verbose logging]" "--message-id[Message id (optional)]" "(--message -m)"{--message,-m}"[Initial thread message text]" "--auto-archive-min[Thread auto-archive minutes]"
}
_openclaw_message_thread_list () {
	_arguments -C "--guild-id[Guild id]" "--channel[Channel: telegram|whatsapp|discord|irc|googlechat|slack|signal|imessage|feishu|nostr|msteams|mattermost|nextcloud-talk|matrix|line|zalo|clickclack|zalouser|synology-chat|tlon|qa-channel|qqbot|twitch]" "--account[Channel account id (accountId)]" "--json[Output result as JSON]" "--dry-run[Print payload and skip sending]" "--verbose[Verbose logging]" "--channel-id[Channel id]" "--include-archived[Include archived threads]" "--before[Read/search before id]" "--limit[Result limit]"
}
_openclaw_message_thread_reply () {
	_arguments -C "(--message -m)"{--message,-m}"[Message body]" "(--target -t)"{--target,-t}"[Recipient/channel: E.164 for WhatsApp/Signal, Telegram chat id/@username, Discord/Slack/Mattermost <channelId|user:ID|channel:ID>, or iMessage handle/chat_id]" "--channel[Channel: telegram|whatsapp|discord|irc|googlechat|slack|signal|imessage|feishu|nostr|msteams|mattermost|nextcloud-talk|matrix|line|zalo|clickclack|zalouser|synology-chat|tlon|qa-channel|qqbot|twitch]" "--account[Channel account id (accountId)]" "--json[Output result as JSON]" "--dry-run[Print payload and skip sending]" "--verbose[Verbose logging]" "--media[Attach media (image/audio/video/document). Accepts local paths or URLs.]" "--reply-to[Reply-to message id]"
}
_openclaw_message_timeout () {
	_arguments -C "--guild-id[Guild id]" "--user-id[User id]" "--channel[Channel: telegram|whatsapp|discord|irc|googlechat|slack|signal|imessage|feishu|nostr|msteams|mattermost|nextcloud-talk|matrix|line|zalo|clickclack|zalouser|synology-chat|tlon|qa-channel|qqbot|twitch]" "--account[Channel account id (accountId)]" "--json[Output result as JSON]" "--dry-run[Print payload and skip sending]" "--verbose[Verbose logging]" "--duration-min[Timeout duration minutes]" "--until[Timeout until]" "--reason[Moderation reason]"
}
_openclaw_message_unpin () {
	_arguments -C "(--target -t)"{--target,-t}"[Recipient/channel: E.164 for WhatsApp/Signal, Telegram chat id/@username, Discord/Slack/Mattermost <channelId|user:ID|channel:ID>, or iMessage handle/chat_id]" "--channel[Channel: telegram|whatsapp|discord|irc|googlechat|slack|signal|imessage|feishu|nostr|msteams|mattermost|nextcloud-talk|matrix|line|zalo|clickclack|zalouser|synology-chat|tlon|qa-channel|qqbot|twitch]" "--account[Channel account id (accountId)]" "--json[Output result as JSON]" "--dry-run[Print payload and skip sending]" "--verbose[Verbose logging]" "--message-id[Message id (or pinned message resource id for MSTeams)]" "--pinned-message-id[Pinned message resource id (MSTeams: from pin or list-pins, not the chat message id)]"
}
_openclaw_message_voice () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'status[Fetch voice status]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(status) _openclaw_message_voice_status ;;
			esac ;;
	esac
}
_openclaw_message_voice_status () {
	_arguments -C "--guild-id[Guild id]" "--user-id[User id]" "--channel[Channel: telegram|whatsapp|discord|irc|googlechat|slack|signal|imessage|feishu|nostr|msteams|mattermost|nextcloud-talk|matrix|line|zalo|clickclack|zalouser|synology-chat|tlon|qa-channel|qqbot|twitch]" "--account[Channel account id (accountId)]" "--json[Output result as JSON]" "--dry-run[Print payload and skip sending]" "--verbose[Verbose logging]"
}
_openclaw_migrate () {
	local -a commands
	local -a options
	_arguments -C "--from[Source directory to migrate from]" "--include-secrets[Import supported credentials and secrets]" "--overwrite[Overwrite conflicting target files after item-level backups]" "--dry-run[Preview only; do not apply changes]" "--yes[Apply without prompting after preview]" "--skill[Select one skill to migrate by name or item id; repeat for multiple skills]" "--plugin[Select one Codex plugin to migrate by name or item id; repeat for multiple plugins]" "--backup-output[Pre-migration backup archive path or directory]" "--no-backup[Skip the pre-migration OpenClaw backup]" "--force[Allow dangerous options such as --no-backup]" "--json[Output JSON]" "--verify-plugin-apps[Codex only: verify source plugin app accessibility with app/list before planning native plugin activation]" "1: :_values 'command' 'list[List migration providers]' 'plan[Preview a migration without changing OpenClaw state]' 'apply[Apply a migration after a verified backup]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(list) _openclaw_migrate_list ;;
				(plan) _openclaw_migrate_plan ;;
				(apply) _openclaw_migrate_apply ;;
			esac ;;
	esac
}
_openclaw_migrate_apply () {
	_arguments -C "--from[Source directory to migrate from]" "--include-secrets[Import supported credentials and secrets]" "--overwrite[Overwrite conflicting target files after item-level backups]" "--json[Output JSON]" "--skill[Select one skill to migrate by name or item id; repeat for multiple skills]" "--plugin[Select one Codex plugin to migrate by name or item id; repeat for multiple plugins]" "--verify-plugin-apps[Codex only: verify source plugin app accessibility with app/list before planning native plugin activation]" "--yes[Apply without prompting]" "--backup-output[Pre-migration backup archive path or directory]" "--no-backup[Skip the pre-migration OpenClaw backup]" "--force[Allow dangerous options such as --no-backup]"
}
_openclaw_migrate_list () {
	_arguments -C "--json[Output JSON]"
}
_openclaw_migrate_plan () {
	_arguments -C "--from[Source directory to migrate from]" "--include-secrets[Import supported credentials and secrets]" "--overwrite[Overwrite conflicting target files after item-level backups]" "--json[Output JSON]" "--skill[Select one skill to migrate by name or item id; repeat for multiple skills]" "--plugin[Select one Codex plugin to migrate by name or item id; repeat for multiple plugins]" "--verify-plugin-apps[Codex only: verify source plugin app accessibility with app/list before planning native plugin activation]"
}
_openclaw_models () {
	local -a commands
	local -a options
	_arguments -C "--status-json[Output JSON (alias for `models status --json`)]" "--status-plain[Plain output (alias for `models status --plain`)]" "--agent[Agent id to inspect (overrides OPENCLAW_AGENT_DIR/PI_CODING_AGENT_DIR)]" "1: :_values 'command' 'list[List models (configured by default)]' 'status[Show configured model state]' 'set[Set the default model]' 'set-image[Set the image model]' 'aliases[Manage model aliases]' 'fallbacks[Manage model fallback list]' 'image-fallbacks[Manage image model fallback list]' 'scan[Scan OpenRouter free models for tools + images]' 'auth[Manage model auth profiles]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(list) _openclaw_models_list ;;
				(status) _openclaw_models_status ;;
				(set) _openclaw_models_set ;;
				(set-image) _openclaw_models_set_image ;;
				(aliases) _openclaw_models_aliases ;;
				(fallbacks) _openclaw_models_fallbacks ;;
				(image-fallbacks) _openclaw_models_image_fallbacks ;;
				(scan) _openclaw_models_scan ;;
				(auth) _openclaw_models_auth ;;
			esac ;;
	esac
}
_openclaw_models_aliases () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'list[List model aliases]' 'add[Add or update a model alias]' 'remove[Remove a model alias]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(list) _openclaw_models_aliases_list ;;
				(add) _openclaw_models_aliases_add ;;
				(remove) _openclaw_models_aliases_remove ;;
			esac ;;
	esac
}
_openclaw_models_aliases_add () {
	_arguments -C
}
_openclaw_models_aliases_list () {
	_arguments -C "--json[Output JSON]" "--plain[Plain output]"
}
_openclaw_models_aliases_remove () {
	_arguments -C
}
_openclaw_models_auth () {
	local -a commands
	local -a options
	_arguments -C "--agent[Agent id for auth commands]" "1: :_values 'command' 'list[List saved auth profiles]' 'add[Interactive auth helper (provider auth or paste token)]' 'login[Run a provider plugin auth flow (OAuth/API key)]' 'setup-token[Run a provider CLI to create/sync a token (TTY required)]' 'paste-token[Paste a token into auth-profiles.json and update config]' 'paste-api-key[Paste an API key into auth-profiles.json and update config]' 'login-github-copilot[Login to GitHub Copilot via GitHub device flow (TTY required)]' 'order[Manage per-agent auth profile order overrides]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(list) _openclaw_models_auth_list ;;
				(add) _openclaw_models_auth_add ;;
				(login) _openclaw_models_auth_login ;;
				(setup-token) _openclaw_models_auth_setup_token ;;
				(paste-token) _openclaw_models_auth_paste_token ;;
				(paste-api-key) _openclaw_models_auth_paste_api_key ;;
				(login-github-copilot) _openclaw_models_auth_login_github_copilot ;;
				(order) _openclaw_models_auth_order ;;
			esac ;;
	esac
}
_openclaw_models_auth_add () {
	_arguments -C
}
_openclaw_models_auth_list () {
	_arguments -C "--provider[Filter by provider id]" "--agent[Agent id (default: configured default agent)]" "--json[Output JSON]"
}
_openclaw_models_auth_login () {
	_arguments -C "--provider[Provider id registered by a plugin]" "--method[Provider auth method id]" "--device-code[Use the provider device-code auth method]" "--set-default[Apply the provider'\''s default model recommendation]"
}
_openclaw_models_auth_login_github_copilot () {
	_arguments -C "--yes[Overwrite existing profile without prompting]"
}
_openclaw_models_auth_order () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'get[Show per-agent auth order override (from auth-state.json)]' 'set[Set per-agent auth order override (writes auth-state.json)]' 'clear[Clear per-agent auth order override (fall back to config/round-robin)]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(get) _openclaw_models_auth_order_get ;;
				(set) _openclaw_models_auth_order_set ;;
				(clear) _openclaw_models_auth_order_clear ;;
			esac ;;
	esac
}
_openclaw_models_auth_order_clear () {
	_arguments -C "--provider[Provider id (e.g. anthropic)]" "--agent[Agent id (default: configured default agent)]"
}
_openclaw_models_auth_order_get () {
	_arguments -C "--provider[Provider id (e.g. anthropic)]" "--agent[Agent id (default: configured default agent)]" "--json[Output JSON]"
}
_openclaw_models_auth_order_set () {
	_arguments -C "--provider[Provider id (e.g. anthropic)]" "--agent[Agent id (default: configured default agent)]"
}
_openclaw_models_auth_paste_api_key () {
	_arguments -C "--provider[Provider id (e.g. openai-codex)]" "--profile-id[Auth profile id (default: <provider>:manual)]"
}
_openclaw_models_auth_paste_token () {
	_arguments -C "--provider[Provider id (e.g. anthropic)]" "--profile-id[Auth profile id (default: <provider>:manual)]" "--expires-in[Optional expiry duration (e.g. 365d, 12h). Stored as absolute expiresAt.]"
}
_openclaw_models_auth_setup_token () {
	_arguments -C "--provider[Provider id]" "--yes[Skip confirmation]"
}
_openclaw_models_fallbacks () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'list[List fallback models]' 'add[Add a fallback model]' 'remove[Remove a fallback model]' 'clear[Clear all fallback models]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(list) _openclaw_models_fallbacks_list ;;
				(add) _openclaw_models_fallbacks_add ;;
				(remove) _openclaw_models_fallbacks_remove ;;
				(clear) _openclaw_models_fallbacks_clear ;;
			esac ;;
	esac
}
_openclaw_models_fallbacks_add () {
	_arguments -C
}
_openclaw_models_fallbacks_clear () {
	_arguments -C
}
_openclaw_models_fallbacks_list () {
	_arguments -C "--json[Output JSON]" "--plain[Plain output]"
}
_openclaw_models_fallbacks_remove () {
	_arguments -C
}
_openclaw_models_image_fallbacks () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'list[List image fallback models]' 'add[Add an image fallback model]' 'remove[Remove an image fallback model]' 'clear[Clear all image fallback models]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(list) _openclaw_models_image_fallbacks_list ;;
				(add) _openclaw_models_image_fallbacks_add ;;
				(remove) _openclaw_models_image_fallbacks_remove ;;
				(clear) _openclaw_models_image_fallbacks_clear ;;
			esac ;;
	esac
}
_openclaw_models_image_fallbacks_add () {
	_arguments -C
}
_openclaw_models_image_fallbacks_clear () {
	_arguments -C
}
_openclaw_models_image_fallbacks_list () {
	_arguments -C "--json[Output JSON]" "--plain[Plain output]"
}
_openclaw_models_image_fallbacks_remove () {
	_arguments -C
}
_openclaw_models_list () {
	_arguments -C "--all[Show full model catalog]" "--local[Filter to local models]" "--provider[Filter by provider id]" "--json[Output JSON]" "--plain[Plain line output]"
}
_openclaw_models_scan () {
	_arguments -C "--min-params[Minimum parameter size (billions)]" "--max-age-days[Skip models older than N days]" "--provider[Filter by provider prefix]" "--max-candidates[Max fallback candidates]" "--timeout[Per-probe timeout in ms]" "--concurrency[Probe concurrency]" "--no-probe[Skip live probes; list free candidates only]" "--yes[Accept defaults without prompting]" "--no-input[Disable prompts (use defaults)]" "--set-default[Set agents.defaults.model to the first selection]" "--set-image[Set agents.defaults.imageModel to the first image selection]" "--json[Output JSON]"
}
_openclaw_models_set () {
	_arguments -C
}
_openclaw_models_set_image () {
	_arguments -C
}
_openclaw_models_status () {
	_arguments -C "--json[Output JSON]" "--plain[Plain output]" "--check[Exit non-zero if auth is expiring/expired (1=expired/missing, 2=expiring)]" "--probe[Probe configured provider auth (live)]" "--probe-provider[Only probe a single provider]" "--probe-profile[Only probe specific auth profile ids (repeat or comma-separated)]" "--probe-timeout[Per-probe timeout in ms]" "--probe-concurrency[Concurrent probes]" "--probe-max-tokens[Probe max tokens (best-effort)]" "--agent[Agent id to inspect (overrides OPENCLAW_AGENT_DIR/PI_CODING_AGENT_DIR)]"
}
_openclaw_node () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'run[Run the headless node host (foreground)]' 'status[Show node host status]' 'install[Install the node host service (launchd/systemd/schtasks)]' 'uninstall[Uninstall the node host service (launchd/systemd/schtasks)]' 'stop[Stop the node host service (launchd/systemd/schtasks)]' 'start[Start the node host service (launchd/systemd/schtasks)]' 'restart[Restart the node host service (launchd/systemd/schtasks)]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(run) _openclaw_node_run ;;
				(status) _openclaw_node_status ;;
				(install) _openclaw_node_install ;;
				(uninstall) _openclaw_node_uninstall ;;
				(stop) _openclaw_node_stop ;;
				(start) _openclaw_node_start ;;
				(restart) _openclaw_node_restart ;;
			esac ;;
	esac
}
_openclaw_node_install () {
	_arguments -C "--host[Gateway host]" "--port[Gateway port]" "--tls[Use TLS for the gateway connection]" "--tls-fingerprint[Expected TLS certificate fingerprint (sha256)]" "--node-id[Override node id (clears pairing token)]" "--display-name[Override node display name]" "--runtime[Service runtime (node|bun). Default: node]" "--force[Reinstall/overwrite if already installed]" "--json[Output JSON]"
}
_openclaw_node_restart () {
	_arguments -C "--json[Output JSON]"
}
_openclaw_node_run () {
	_arguments -C "--host[Gateway host]" "--port[Gateway port]" "--tls[Use TLS for the gateway connection]" "--tls-fingerprint[Expected TLS certificate fingerprint (sha256)]" "--node-id[Override node id (clears pairing token)]" "--display-name[Override node display name]"
}
_openclaw_node_start () {
	_arguments -C "--json[Output JSON]"
}
_openclaw_node_status () {
	_arguments -C "--json[Output JSON]"
}
_openclaw_node_stop () {
	_arguments -C "--json[Output JSON]"
}
_openclaw_node_uninstall () {
	_arguments -C "--json[Output JSON]"
}
_openclaw_nodes () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'status[List known nodes with connection status and capabilities]' 'describe[Describe a node (capabilities + supported invoke commands)]' 'list[List pending and paired nodes]' 'pending[List pending pairing requests]' 'approve[Approve a pending pairing request]' 'reject[Reject a pending pairing request]' 'remove[Remove a paired node entry]' 'rename[Rename a paired node (display name override)]' 'invoke[Invoke a command on a paired node]' 'notify[Send a local notification on a node (mac only)]' 'push[Send an APNs test push to an iOS node]' 'camera[Capture camera media from a paired node]' 'screen[Capture screen recordings from a paired node]' 'location[Fetch location from a paired node]' 'canvas[Capture or render canvas content from a paired node]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(status) _openclaw_nodes_status ;;
				(describe) _openclaw_nodes_describe ;;
				(list) _openclaw_nodes_list ;;
				(pending) _openclaw_nodes_pending ;;
				(approve) _openclaw_nodes_approve ;;
				(reject) _openclaw_nodes_reject ;;
				(remove) _openclaw_nodes_remove ;;
				(rename) _openclaw_nodes_rename ;;
				(invoke) _openclaw_nodes_invoke ;;
				(notify) _openclaw_nodes_notify ;;
				(push) _openclaw_nodes_push ;;
				(camera) _openclaw_nodes_camera ;;
				(screen) _openclaw_nodes_screen ;;
				(location) _openclaw_nodes_location ;;
				(canvas) _openclaw_nodes_canvas ;;
			esac ;;
	esac
}
_openclaw_nodes_approve () {
	_arguments -C "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--json[Output JSON]"
}
_openclaw_nodes_camera () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'list[List available cameras on a node]' 'snap[Capture a photo from a node camera (prints MEDIA:<path>)]' 'clip[Capture a short video clip from a node camera (prints MEDIA:<path>)]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(list) _openclaw_nodes_camera_list ;;
				(snap) _openclaw_nodes_camera_snap ;;
				(clip) _openclaw_nodes_camera_clip ;;
			esac ;;
	esac
}
_openclaw_nodes_camera_clip () {
	_arguments -C "--node[Node id, name, or IP]" "--facing[Camera facing]" "--device-id[Camera device id (from nodes camera list)]" "--duration[Duration (default 3000ms; supports ms/s/m, e.g. 10s)]" "--no-audio[Disable audio capture]" "--invoke-timeout[Node invoke timeout in ms (default 90000)]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--json[Output JSON]"
}
_openclaw_nodes_camera_list () {
	_arguments -C "--node[Node id, name, or IP]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--json[Output JSON]"
}
_openclaw_nodes_camera_snap () {
	_arguments -C "--node[Node id, name, or IP]" "--facing[Camera facing]" "--device-id[Camera device id (from nodes camera list)]" "--max-width[Max width in px (optional)]" "--quality[JPEG quality (default 0.9)]" "--delay-ms[Delay before capture in ms (macOS default 2000)]" "--invoke-timeout[Node invoke timeout in ms (default 20000)]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--json[Output JSON]"
}
_openclaw_nodes_canvas () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'snapshot[Capture a canvas snapshot (prints MEDIA:<path>)]' 'present[Show the canvas (optionally with a target URL/path)]' 'hide[Hide the canvas]' 'navigate[Navigate the canvas to a URL]' 'eval[Evaluate JavaScript in the canvas]' 'a2ui[Render A2UI content on the canvas]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(snapshot) _openclaw_nodes_canvas_snapshot ;;
				(present) _openclaw_nodes_canvas_present ;;
				(hide) _openclaw_nodes_canvas_hide ;;
				(navigate) _openclaw_nodes_canvas_navigate ;;
				(eval) _openclaw_nodes_canvas_eval ;;
				(a2ui) _openclaw_nodes_canvas_a2ui ;;
			esac ;;
	esac
}
_openclaw_nodes_canvas_a2ui () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'push[Push A2UI JSONL to the canvas]' 'reset[Reset A2UI renderer state]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(push) _openclaw_nodes_canvas_a2ui_push ;;
				(reset) _openclaw_nodes_canvas_a2ui_reset ;;
			esac ;;
	esac
}
_openclaw_nodes_canvas_a2ui_push () {
	_arguments -C "--jsonl[Path to JSONL payload]" "--text[Render a quick A2UI text payload]" "--node[Node id, name, or IP]" "--invoke-timeout[Node invoke timeout in ms]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--json[Output JSON]"
}
_openclaw_nodes_canvas_a2ui_reset () {
	_arguments -C "--node[Node id, name, or IP]" "--invoke-timeout[Node invoke timeout in ms]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--json[Output JSON]"
}
_openclaw_nodes_canvas_eval () {
	_arguments -C "--js[JavaScript to evaluate]" "--node[Node id, name, or IP]" "--invoke-timeout[Node invoke timeout in ms]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--json[Output JSON]"
}
_openclaw_nodes_canvas_hide () {
	_arguments -C "--node[Node id, name, or IP]" "--invoke-timeout[Node invoke timeout in ms]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--json[Output JSON]"
}
_openclaw_nodes_canvas_navigate () {
	_arguments -C "--node[Node id, name, or IP]" "--invoke-timeout[Node invoke timeout in ms]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--json[Output JSON]"
}
_openclaw_nodes_canvas_present () {
	_arguments -C "--node[Node id, name, or IP]" "--target[Target URL/path (optional)]" "--x[Placement x coordinate]" "--y[Placement y coordinate]" "--width[Placement width]" "--height[Placement height]" "--invoke-timeout[Node invoke timeout in ms]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--json[Output JSON]"
}
_openclaw_nodes_canvas_snapshot () {
	_arguments -C "--node[Node id, name, or IP]" "--format[Image format]" "--max-width[Max width in px (optional)]" "--quality[JPEG quality (optional)]" "--invoke-timeout[Node invoke timeout in ms (default 20000)]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--json[Output JSON]"
}
_openclaw_nodes_describe () {
	_arguments -C "--node[Node id, name, or IP]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--json[Output JSON]"
}
_openclaw_nodes_invoke () {
	_arguments -C "--node[Node id, name, or IP]" "--command[Command (e.g. canvas.eval)]" "--params[JSON object string for params]" "--invoke-timeout[Node invoke timeout in ms (default 15000)]" "--idempotency-key[Idempotency key (optional)]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--json[Output JSON]"
}
_openclaw_nodes_list () {
	_arguments -C "--connected[Only show connected nodes]" "--last-connected[Only show nodes connected within duration (e.g. 24h)]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--json[Output JSON]"
}
_openclaw_nodes_location () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'get[Fetch the current location from a node]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(get) _openclaw_nodes_location_get ;;
			esac ;;
	esac
}
_openclaw_nodes_location_get () {
	_arguments -C "--node[Node id, name, or IP]" "--max-age[Use cached location newer than this (ms)]" "--accuracy[Desired accuracy (default: balanced/precise depending on node setting)]" "--location-timeout[Location fix timeout (ms)]" "--invoke-timeout[Node invoke timeout in ms (default 20000)]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--json[Output JSON]"
}
_openclaw_nodes_notify () {
	_arguments -C "--node[Node id, name, or IP]" "--title[Notification title]" "--body[Notification body]" "--sound[Notification sound]" "--priority[Notification priority]" "--delivery[Delivery mode]" "--invoke-timeout[Node invoke timeout in ms (default 15000)]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--json[Output JSON]"
}
_openclaw_nodes_pending () {
	_arguments -C "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--json[Output JSON]"
}
_openclaw_nodes_push () {
	_arguments -C "--node[Node id, name, or IP]" "--title[Push title]" "--body[Push body]" "--environment[Override APNs environment]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--json[Output JSON]"
}
_openclaw_nodes_reject () {
	_arguments -C "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--json[Output JSON]"
}
_openclaw_nodes_remove () {
	_arguments -C "--node[Node id, name, or IP]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--json[Output JSON]"
}
_openclaw_nodes_rename () {
	_arguments -C "--node[Node id, name, or IP]" "--name[New display name]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--json[Output JSON]"
}
_openclaw_nodes_screen () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'record[Capture a short screen recording from a node (prints MEDIA:<path>)]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(record) _openclaw_nodes_screen_record ;;
			esac ;;
	esac
}
_openclaw_nodes_screen_record () {
	_arguments -C "--node[Node id, name, or IP]" "--screen[Screen index (0 = primary)]" "--duration[Clip duration (ms or 10s)]" "--fps[Frames per second]" "--no-audio[Disable microphone audio capture]" "--out[Output path]" "--invoke-timeout[Node invoke timeout in ms (default 120000)]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--json[Output JSON]"
}
_openclaw_nodes_status () {
	_arguments -C "--connected[Only show connected nodes]" "--last-connected[Only show nodes connected within duration (e.g. 24h)]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--json[Output JSON]"
}
_openclaw_onboard () {
	_arguments -C "--workspace[Agent workspace directory (default: ~/.openclaw/workspace)]" "--reset[Reset config + credentials + sessions before running onboard (workspace only with --reset-scope full)]" "--reset-scope[Reset scope: config|config+creds+sessions|full]" "--non-interactive[Run without prompts]" "--modern[Use the conversational setup/repair assistant]" "--accept-risk[Acknowledge that agents are powerful and full system access is risky (required for --non-interactive)]" "--flow[Onboard flow: quickstart|advanced|manual|import]" "--mode[Onboard mode: local|remote]" "--auth-choice[Auth: custom-api-key|skip|claude-cli|codex-cli|apiKey|anthropic-cli|setup-token|arceeai-api-key|byteplus-api-key|cerebras-api-key|openai-device-code|openai|openai-codex|openai-codex-device-code|chutes|chutes-api-key|cloudflare-ai-gateway-api-key|zai-cn|codex|qwen-api-key-cn|qwen-api-key|zai-coding-cn|zai-coding-global|copilot-proxy|deepinfra-api-key|deepseek-api-key|fireworks-api-key|google-gemini-cli|github-copilot|zai-global|gemini-api-key|google-vertex-api-key|groq-api-key|huggingface-api-key|kilocode-api-key|kimi-code-api-key|litellm-api-key|lmstudio|microsoft-foundry-apikey|microsoft-foundry-entra|minimax-cn-api|minimax-global-api|minimax-cn-oauth|minimax-global-oauth|mistral-api-key|moonshot-api-key|moonshot-api-key-cn|nvidia-api-key|ollama|openai-api-key|openai-codex-api-key|opencode-go|opencode-zen|arceeai-openrouter|openrouter-api-key|qianfan-api-key|sglang|qwen-standard-api-key-cn|qwen-standard-api-key|stepfun-standard-api-key-cn|stepfun-standard-api-key-intl|stepfun-plan-api-key-cn|stepfun-plan-api-key-intl|synthetic-api-key|tokenhub-api-key|together-api-key|venice-api-key|ai-gateway-api-key|vllm|volcengine-api-key|xai-api-key|xai-device-code|xai-oauth|xiaomi-api-key|zai-api-key]" "--token-provider[Token provider id (non-interactive; used with --auth-choice token)]" "--token[Token value (non-interactive; used with --auth-choice token)]" "--token-profile-id[Auth profile id (non-interactive; default: <provider>:manual)]" "--token-expires-in[Optional token expiry duration (e.g. 365d, 12h)]" "--secret-input-mode[API key persistence mode: plaintext|ref (default: plaintext)]" "--cloudflare-ai-gateway-account-id[Cloudflare Account ID]" "--cloudflare-ai-gateway-gateway-id[Cloudflare AI Gateway ID]" "--alibaba-model-studio-api-key[Alibaba Model Studio API key]" "--anthropic-api-key[Anthropic API key]" "--arceeai-api-key[Arcee AI API key]" "--openrouter-api-key[OpenRouter API key for Arcee AI models]" "--byteplus-api-key[BytePlus API key]" "--cerebras-api-key[Cerebras API key]" "--chutes-api-key[Chutes API key]" "--cloudflare-ai-gateway-api-key[Cloudflare AI Gateway API key]" "--comfy-api-key[Comfy Cloud API key]" "--deepinfra-api-key[DeepInfra API key]" "--deepseek-api-key[DeepSeek API key]" "--fal-api-key[fal API key]" "--fireworks-api-key[Fireworks API key]" "--github-copilot-token[GitHub Copilot OAuth token]" "--gemini-api-key[Gemini API key]" "--huggingface-api-key[Hugging Face API key (HF token)]" "--kilocode-api-key[Kilo Gateway API key]" "--kimi-code-api-key[Kimi Code API key (subscription)]" "--litellm-api-key[LiteLLM API key]" "--lmstudio-api-key[LM Studio API key]" "--minimax-api-key[MiniMax API key]" "--mistral-api-key[Mistral API key]" "--moonshot-api-key[Moonshot API key]" "--nvidia-api-key[NVIDIA API key]" "--openai-api-key[OpenAI API Key Backup]" "--opencode-zen-api-key[OpenCode API key (Zen catalog)]" "--opencode-go-api-key[OpenCode API key (Go catalog)]" "--qianfan-api-key[QIANFAN API key]" "--modelstudio-standard-api-key-cn[Qwen Cloud standard API key (China)]" "--modelstudio-standard-api-key[Qwen Cloud standard API key (Global/Intl)]" "--modelstudio-api-key-cn[Qwen Cloud Coding Plan API key (China)]" "--modelstudio-api-key[Qwen Cloud Coding Plan API key (Global/Intl)]" "--runway-api-key[Runway API key]" "--stepfun-api-key[StepFun API key]" "--synthetic-api-key[Synthetic API key]" "--tokenhub-api-key[Tencent TokenHub API key]" "--together-api-key[Together AI API key]" "--venice-api-key[Venice API key]" "--ai-gateway-api-key[Vercel AI Gateway API key]" "--volcengine-api-key[Volcano Engine API key]" "--vydra-api-key[Vydra API key]" "--xai-api-key[xAI API key]" "--xiaomi-api-key[Xiaomi API key]" "--zai-api-key[Z.AI API key]" "--custom-base-url[Custom provider base URL]" "--custom-api-key[Custom provider API key (optional)]" "--custom-model-id[Custom provider model ID]" "--custom-provider-id[Custom provider ID (optional; auto-derived by default)]" "--custom-compatibility[Custom provider API compatibility: openai|anthropic (default: openai)]" "--custom-image-input[Mark the custom provider model as image-capable]" "--custom-text-input[Mark the custom provider model as text-only]" "--gateway-port[Gateway port]" "--gateway-bind[Gateway bind: loopback|tailnet|lan|auto|custom]" "--gateway-auth[Gateway auth: token|password]" "--gateway-token[Gateway token (token auth)]" "--gateway-token-ref-env[Gateway token SecretRef env var name (token auth; e.g. OPENCLAW_GATEWAY_TOKEN)]" "--gateway-password[Gateway password (password auth)]" "--remote-url[Remote Gateway WebSocket URL]" "--remote-token[Remote Gateway token (optional)]" "--tailscale[Tailscale: off|serve|funnel]" "--tailscale-reset-on-exit[Reset tailscale serve/funnel on exit]" "--install-daemon[Install gateway service]" "--no-install-daemon[Skip gateway service install]" "--skip-daemon[Skip gateway service install]" "--daemon-runtime[Daemon runtime: node|bun]" "--skip-channels[Skip channel setup]" "--skip-skills[Skip skills setup]" "--skip-bootstrap[Skip creating default agent workspace files]" "--skip-search[Skip search provider setup]" "--skip-health[Skip health check]" "--skip-ui[Skip Control UI/TUI prompts]" "--suppress-gateway-token-output[Suppress token-bearing Gateway/UI output]" "--skip-hooks[Skip hook setup]" "--node-manager[Node manager for skills: npm|pnpm|bun]" "--import-from[Migration provider to run during onboarding]" "--import-source[Source agent home for --import-from]" "--import-secrets[Import supported secrets during onboarding migration]" "--json[Output JSON summary]"
}
_openclaw_pairing () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'list[List pending pairing requests]' 'approve[Approve a pairing code and allow that sender]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(list) _openclaw_pairing_list ;;
				(approve) _openclaw_pairing_approve ;;
			esac ;;
	esac
}
_openclaw_pairing_approve () {
	_arguments -C "--channel[Channel ()]" "--account[Account id (for multi-account channels)]" "--notify[Notify the requester on the same channel]"
}
_openclaw_pairing_list () {
	_arguments -C "--channel[Channel ()]" "--account[Account id (for multi-account channels)]" "--json[Print JSON]"
}
_openclaw_plugins () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'list[List discovered plugins]' 'search[Search ClawHub plugin packages]' 'inspect[Inspect plugin details]' 'enable[Enable a plugin in config]' 'disable[Disable a plugin in config]' 'uninstall[Uninstall a plugin]' 'install[Install a plugin or hook pack (path, archive, npm spec, git repo, clawhub:package, or marketplace entry)]' 'update[Update installed plugins and tracked hook packs]' 'registry[Inspect or rebuild the persisted plugin registry]' 'doctor[Report plugin load issues]' 'build[Generate simple tool plugin metadata]' 'validate[Validate simple tool plugin metadata]' 'init[Create a simple tool plugin project]' 'marketplace[Inspect Claude-compatible plugin marketplaces]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(list) _openclaw_plugins_list ;;
				(search) _openclaw_plugins_search ;;
				(inspect) _openclaw_plugins_inspect ;;
				(enable) _openclaw_plugins_enable ;;
				(disable) _openclaw_plugins_disable ;;
				(uninstall) _openclaw_plugins_uninstall ;;
				(install) _openclaw_plugins_install ;;
				(update) _openclaw_plugins_update ;;
				(registry) _openclaw_plugins_registry ;;
				(doctor) _openclaw_plugins_doctor ;;
				(build) _openclaw_plugins_build ;;
				(validate) _openclaw_plugins_validate ;;
				(init) _openclaw_plugins_init ;;
				(marketplace) _openclaw_plugins_marketplace ;;
			esac ;;
	esac
}
_openclaw_plugins_build () {
	_arguments -C "--root[Plugin package root]" "--entry[Plugin entry module relative to --root]" "--check[Fail if generated metadata is out of date]"
}
_openclaw_plugins_disable () {
	_arguments -C
}
_openclaw_plugins_doctor () {
	_arguments -C
}
_openclaw_plugins_enable () {
	_arguments -C
}
_openclaw_plugins_init () {
	_arguments -C "--directory[Output directory]" "--name[Display name]" "--force[Overwrite an existing output directory]"
}
_openclaw_plugins_inspect () {
	_arguments -C "--all[Inspect all plugins]" "--runtime[Load plugin runtime for hooks/tools/diagnostics]" "--json[Print JSON]"
}
_openclaw_plugins_install () {
	_arguments -C "(--link -l)"{--link,-l}"[Link a local path instead of copying]" "--force[Overwrite an existing installed plugin or hook pack]" "--pin[Record npm installs as exact resolved <name>@<version>]" "--dangerously-force-unsafe-install[Bypass built-in dangerous-code install blocking (plugin hooks may still block)]" "--marketplace[Install a Claude marketplace plugin from a local repo/path or git/GitHub source]"
}
_openclaw_plugins_list () {
	_arguments -C "--json[Print JSON]" "--enabled[Only show enabled plugins]" "--verbose[Show detailed entries]"
}
_openclaw_plugins_marketplace () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'list[List plugins published by a marketplace source]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(list) _openclaw_plugins_marketplace_list ;;
			esac ;;
	esac
}
_openclaw_plugins_marketplace_list () {
	_arguments -C "--json[Print JSON]"
}
_openclaw_plugins_registry () {
	_arguments -C "--json[Print JSON]" "--refresh[Rebuild the persisted registry from current plugin manifests]"
}
_openclaw_plugins_search () {
	_arguments -C "--limit[Max results]" "--json[Print JSON]"
}
_openclaw_plugins_uninstall () {
	_arguments -C "--keep-files[Keep installed files on disk]" "--keep-config[Deprecated alias for --keep-files]" "--force[Skip confirmation prompt]" "--dry-run[Show what would be removed without making changes]"
}
_openclaw_plugins_update () {
	_arguments -C "--all[Update all tracked plugins and hook packs]" "--dry-run[Show what would change without writing]" "--dangerously-force-unsafe-install[Bypass built-in dangerous-code update blocking for plugins (plugin hooks may still block)]"
}
_openclaw_plugins_validate () {
	_arguments -C "--root[Plugin package root]" "--entry[Plugin entry module relative to --root]"
}
_openclaw_proxy () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'start[Start the local explicit debug proxy]' 'run[Run a child command with OpenClaw debug proxy capture enabled]' 'validate[Validate the operator-managed network proxy]' 'coverage[Report current debug proxy transport coverage and remaining gaps]' 'sessions[List recent capture sessions]' 'query[Run a built-in query preset against captured traffic]' 'blob[Read a captured payload blob by id]' 'purge[Delete all captured traffic metadata and blobs]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(start) _openclaw_proxy_start ;;
				(run) _openclaw_proxy_run ;;
				(validate) _openclaw_proxy_validate ;;
				(coverage) _openclaw_proxy_coverage ;;
				(sessions) _openclaw_proxy_sessions ;;
				(query) _openclaw_proxy_query ;;
				(blob) _openclaw_proxy_blob ;;
				(purge) _openclaw_proxy_purge ;;
			esac ;;
	esac
}
_openclaw_proxy_blob () {
	_arguments -C "--id[Blob id]"
}
_openclaw_proxy_coverage () {
	_arguments -C
}
_openclaw_proxy_purge () {
	_arguments -C
}
_openclaw_proxy_query () {
	_arguments -C "--preset[Query preset: double-sends, retry-storms, cache-busting, ws-duplicate-frames, missing-ack, error-bursts]" "--session[Restrict to a capture session id]"
}
_openclaw_proxy_run () {
	_arguments -C "--host[Bind host]" "--port[Bind port]"
}
_openclaw_proxy_sessions () {
	_arguments -C "--limit[Maximum sessions to show]"
}
_openclaw_proxy_start () {
	_arguments -C "--host[Bind host]" "--port[Bind port]"
}
_openclaw_proxy_validate () {
	_arguments -C "--json[Print machine-readable JSON]" "--proxy-url[Proxy URL to validate instead of config/env]" "--proxy-ca-file[CA bundle file for verifying an HTTPS proxy endpoint]" "--allowed-url[Destination expected to succeed through the proxy]" "--denied-url[Destination expected to be blocked by the proxy]" "--apns-reachable[Also verify sandbox APNs HTTP/2 is reachable through the proxy]" "--apns-authority[APNs authority to probe with --apns-reachable]" "--timeout-ms[Per-request timeout in milliseconds]"
}
_openclaw_qr () {
	_arguments -C "--remote[Use gateway.remote.url and gateway.remote token/password (ignores device-pair publicUrl)]" "--url[Override gateway URL used in the setup payload]" "--public-url[Override gateway public URL used in the setup payload]" "--token[Override gateway token for setup payload]" "--password[Override gateway password for setup payload]" "--setup-code-only[Print only the setup code]" "--no-ascii[Skip ASCII QR rendering]" "--json[Output JSON]"
}
_openclaw_reset () {
	_arguments -C "--scope[config|config+creds+sessions|full (default: interactive prompt)]" "--yes[Skip confirmation prompts]" "--non-interactive[Disable prompts (requires --scope + --yes)]" "--dry-run[Print actions without removing files]"
}
_openclaw_root_completion () {
	local -a commands
	local -a options
	_arguments -C "(--version -V)"{--version,-V}"[output the version number]" "--container[Run the CLI inside a running Podman/Docker container named <name> (default: env OPENCLAW_CONTAINER)]" "--dev[Dev profile: isolate state under ~/.openclaw-dev, default gateway port 19001, and shift derived ports (browser/canvas)]" "--profile[Use a named profile (isolates OPENCLAW_STATE_DIR/OPENCLAW_CONFIG_PATH under ~/.openclaw-<name>)]" "--log-level[Global log level override for file + console (silent|fatal|error|warn|info|debug|trace)]" "--no-color[Disable ANSI colors]" "1: :_values 'command' 'completion[Generate shell completion script]' 'crestodian[Open the ring-zero setup and repair helper]' 'setup[Create baseline config/workspace files; use --wizard for full onboarding]' 'onboard[Guided setup for auth, models, Gateway, workspace, channels, and skills]' 'configure[Interactive configuration for credentials, channels, gateway, and agent defaults]' 'config[Non-interactive config helpers (get/set/patch/unset/file/schema/validate). Run without subcommand for guided setup.]' 'backup[Create and verify local backup archives for OpenClaw state]' 'migrate[Import state from another agent system]' 'doctor[Health checks + quick fixes for the gateway and channels]' 'dashboard[Open the Control UI with your current token]' 'reset[Reset local config/state (keeps the CLI installed)]' 'uninstall[Uninstall the gateway service + local data (CLI remains)]' 'message[Send, read, and manage messages and channel actions]' 'mcp[Manage OpenClaw MCP config and channel bridge]' 'agent[Run an agent turn via the Gateway (use --local for embedded)]' 'agents[Manage isolated agents (workspaces + auth + routing)]' 'status[Show channel health and recent session recipients]' 'health[Fetch health from the running gateway]' 'sessions[List stored conversation sessions]' 'commitments[List and manage inferred follow-up commitments]' 'tasks[Inspect durable background tasks and TaskFlow state]' 'acp[Run an ACP bridge backed by the Gateway]' 'gateway[Run, inspect, and query the WebSocket Gateway]' 'daemon[Manage the Gateway service (launchd/systemd/schtasks)]' 'logs[Tail gateway file logs via RPC]' 'system[System tools (events, heartbeat, presence)]' 'models[Model discovery, scanning, and configuration]' 'infer[Run provider-backed inference commands through a stable CLI surface]' 'approvals[Manage exec approvals (gateway or node host)]' 'exec-policy[Show or synchronize requested exec policy with host approvals]' 'nodes[Manage gateway-owned nodes (pairing, status, invoke, and media)]' 'devices[Device pairing and auth tokens]' 'node[Run and manage the headless node host service]' 'sandbox[Manage sandbox containers (Docker-based agent isolation)]' 'tui[Open a terminal UI connected to the Gateway]' 'cron[Manage cron jobs (via Gateway)]' 'dns[DNS helpers for wide-area discovery (Tailscale + CoreDNS)]' 'docs[Search the live OpenClaw docs]' 'proxy[Run the OpenClaw debug proxy and inspect captured traffic]' 'hooks[Manage internal agent hooks]' 'webhooks[Webhook helpers and integrations]' 'qr[Generate a mobile pairing QR code and setup code]' 'clawbot[Legacy clawbot command aliases]' 'pairing[Secure DM pairing (approve inbound requests)]' 'plugins[Manage OpenClaw plugins and extensions]' 'channels[Manage connected chat channels and accounts]' 'directory[Lookup contact and group IDs (self, peers, groups) for supported chat channels]' 'security[Audit local config and state for common security foot-guns]' 'secrets[Secrets runtime controls]' 'skills[List and inspect available skills]' 'update[Update OpenClaw and inspect update channel status]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(completion) _openclaw_completion ;;
				(crestodian) _openclaw_crestodian ;;
				(setup) _openclaw_setup ;;
				(onboard) _openclaw_onboard ;;
				(configure) _openclaw_configure ;;
				(config) _openclaw_config ;;
				(backup) _openclaw_backup ;;
				(migrate) _openclaw_migrate ;;
				(doctor) _openclaw_doctor ;;
				(dashboard) _openclaw_dashboard ;;
				(reset) _openclaw_reset ;;
				(uninstall) _openclaw_uninstall ;;
				(message) _openclaw_message ;;
				(mcp) _openclaw_mcp ;;
				(agent) _openclaw_agent ;;
				(agents) _openclaw_agents ;;
				(status) _openclaw_status ;;
				(health) _openclaw_health ;;
				(sessions) _openclaw_sessions ;;
				(commitments) _openclaw_commitments ;;
				(tasks) _openclaw_tasks ;;
				(acp) _openclaw_acp ;;
				(gateway) _openclaw_gateway ;;
				(daemon) _openclaw_daemon ;;
				(logs) _openclaw_logs ;;
				(system) _openclaw_system ;;
				(models) _openclaw_models ;;
				(infer) _openclaw_infer ;;
				(approvals) _openclaw_approvals ;;
				(exec-policy) _openclaw_exec_policy ;;
				(nodes) _openclaw_nodes ;;
				(devices) _openclaw_devices ;;
				(node) _openclaw_node ;;
				(sandbox) _openclaw_sandbox ;;
				(tui) _openclaw_tui ;;
				(cron) _openclaw_cron ;;
				(dns) _openclaw_dns ;;
				(docs) _openclaw_docs ;;
				(proxy) _openclaw_proxy ;;
				(hooks) _openclaw_hooks ;;
				(webhooks) _openclaw_webhooks ;;
				(qr) _openclaw_qr ;;
				(clawbot) _openclaw_clawbot ;;
				(pairing) _openclaw_pairing ;;
				(plugins) _openclaw_plugins ;;
				(channels) _openclaw_channels ;;
				(directory) _openclaw_directory ;;
				(security) _openclaw_security ;;
				(secrets) _openclaw_secrets ;;
				(skills) _openclaw_skills ;;
				(update) _openclaw_update ;;
			esac ;;
	esac
}
_openclaw_sandbox () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'list[List sandbox containers and their status]' 'recreate[Remove containers to force recreation with updated config]' 'explain[Explain effective sandbox/tool policy for a session/agent]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(list) _openclaw_sandbox_list ;;
				(recreate) _openclaw_sandbox_recreate ;;
				(explain) _openclaw_sandbox_explain ;;
			esac ;;
	esac
}
_openclaw_sandbox_explain () {
	_arguments -C "--session[Session key to inspect (defaults to agent main)]" "--agent[Agent id to inspect (defaults to derived agent)]" "--json[Output result as JSON]"
}
_openclaw_sandbox_list () {
	_arguments -C "--json[Output result as JSON]" "--browser[List browser containers only]"
}
_openclaw_sandbox_recreate () {
	_arguments -C "--all[Recreate all sandbox containers]" "--session[Recreate container for specific session]" "--agent[Recreate containers for specific agent]" "--browser[Only recreate browser containers]" "--force[Skip confirmation prompt]"
}
_openclaw_secrets () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'reload[Re-resolve secret references and atomically swap runtime snapshot]' 'audit[Audit plaintext secrets, unresolved refs, and precedence drift]' 'configure[Interactive secrets helper (provider setup + SecretRef mapping + preflight)]' 'apply[Apply a previously generated secrets plan]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(reload) _openclaw_secrets_reload ;;
				(audit) _openclaw_secrets_audit ;;
				(configure) _openclaw_secrets_configure ;;
				(apply) _openclaw_secrets_apply ;;
			esac ;;
	esac
}
_openclaw_secrets_apply () {
	_arguments -C "--from[Path to plan JSON]" "--dry-run[Validate/preflight only]" "--allow-exec[Allow exec SecretRef checks (may execute provider commands)]" "--json[Output JSON]"
}
_openclaw_secrets_audit () {
	_arguments -C "--check[Exit non-zero when findings are present]" "--allow-exec[Allow exec SecretRef resolution during audit (may execute provider commands)]" "--json[Output JSON]"
}
_openclaw_secrets_configure () {
	_arguments -C "--apply[Apply changes immediately after preflight]" "--yes[Skip apply confirmation prompt]" "--providers-only[Configure secrets.providers only, skip credential mapping]" "--skip-provider-setup[Skip provider setup and only map credential fields to existing providers]" "--agent[Agent id for auth-profiles targets (default: configured default agent)]" "--allow-exec[Allow exec SecretRef preflight checks (may execute provider commands)]" "--plan-out[Write generated plan JSON to a file]" "--json[Output JSON]"
}
_openclaw_secrets_reload () {
	_arguments -C "--json[Output JSON]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--expect-final[Wait for final response (agent)]"
}
_openclaw_security () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'audit[Audit config + local state for common security foot-guns]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(audit) _openclaw_security_audit ;;
			esac ;;
	esac
}
_openclaw_security_audit () {
	_arguments -C "--deep[Attempt live Gateway probes and plugin-owned collector checks]" "--token[Use explicit gateway token for deep probe auth]" "--password[Use explicit gateway password for deep probe auth]" "--fix[Apply safe fixes (tighten defaults + chmod state/config)]" "--json[Print JSON]"
}
_openclaw_sessions () {
	local -a commands
	local -a options
	_arguments -C "--json[Output as JSON]" "--verbose[Verbose logging]" "--store[Path to session store (default: resolved from config)]" "--agent[Agent id to inspect (default: configured default agent)]" "--all-agents[Aggregate sessions across all configured agents]" "--active[Only show sessions updated within the past N minutes]" "--limit[Max sessions to show (default: 100; use \"all\" for full output)]" "1: :_values 'command' 'list[List stored conversation sessions]' 'cleanup[Run session-store maintenance now]' 'export-trajectory[Export a redacted trajectory bundle for a stored session]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(list) _openclaw_sessions_list ;;
				(cleanup) _openclaw_sessions_cleanup ;;
				(export-trajectory) _openclaw_sessions_export_trajectory ;;
			esac ;;
	esac
}
_openclaw_sessions_cleanup () {
	_arguments -C "--store[Path to session store (default: resolved from config)]" "--agent[Agent id to maintain (default: configured default agent)]" "--all-agents[Run maintenance across all configured agents]" "--dry-run[Preview maintenance actions without writing]" "--enforce[Apply maintenance even when configured mode is warn]" "--fix-missing[Remove store entries whose transcript files are missing (bypasses age/count retention)]" "--fix-dm-scope[Retire stale direct-DM session rows that no longer match session.dmScope=main]" "--active-key[Protect this session key from budget-eviction]" "--json[Output JSON]"
}
_openclaw_sessions_export_trajectory () {
	_arguments -C "--session-key[Session key to export]" "--output[Output directory name inside .openclaw/trajectory-exports]" "--workspace[Workspace root for the export (default: current directory)]" "--store[Path to session store (default: resolved from session key)]" "--agent[Agent id for resolving the default session store]" "--request-json-base64[Base64url-encoded export request]" "--json[Output JSON]"
}
_openclaw_sessions_list () {
	_arguments -C "--json[Output as JSON]" "--verbose[Verbose logging]" "--store[Path to session store (default: resolved from config)]" "--agent[Agent id to inspect (default: configured default agent)]" "--all-agents[Aggregate sessions across all configured agents]" "--active[Only show sessions updated within the past N minutes]" "--limit[Max sessions to show (default: 100; use \"all\" for full output)]"
}
_openclaw_setup () {
	_arguments -C "--workspace[Agent workspace directory (default: ~/.openclaw/workspace; stored as agents.defaults.workspace)]" "--wizard[Run interactive onboarding]" "--non-interactive[Run onboarding without prompts]" "--mode[Onboard mode: local|remote]" "--import-from[Migration provider to run during onboarding]" "--import-source[Source agent home for --import-from]" "--import-secrets[Import supported secrets during onboarding migration]" "--remote-url[Remote Gateway WebSocket URL]" "--remote-token[Remote Gateway token (optional)]"
}
_openclaw_skills () {
	local -a commands
	local -a options
	_arguments -C "--agent[Target agent workspace (defaults to cwd-inferred, then default agent)]" "1: :_values 'command' 'search[Search ClawHub skills]' 'install[Install a skill from ClawHub, git, or a local directory]' 'update[Update ClawHub-installed skills in the active or shared managed directory]' 'list[List all available skills]' 'info[Show detailed information about a skill]' 'check[Check which skills are ready, visible, or missing requirements]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(search) _openclaw_skills_search ;;
				(install) _openclaw_skills_install ;;
				(update) _openclaw_skills_update ;;
				(list) _openclaw_skills_list ;;
				(info) _openclaw_skills_info ;;
				(check) _openclaw_skills_check ;;
			esac ;;
	esac
}
_openclaw_skills_check () {
	_arguments -C "--agent[Target agent workspace (defaults to cwd-inferred, then default agent)]" "--json[Output as JSON]"
}
_openclaw_skills_info () {
	_arguments -C "--json[Output as JSON]" "--agent[Target agent workspace (defaults to cwd-inferred, then default agent)]"
}
_openclaw_skills_install () {
	_arguments -C "--version[Install a specific version]" "--force[Overwrite an existing workspace skill]" "--global[Install into the shared managed skills directory]" "--agent[Target agent workspace (defaults to cwd-inferred, then default agent)]" "--as[Install a git/local skill under this slug]"
}
_openclaw_skills_list () {
	_arguments -C "--json[Output as JSON]" "--eligible[Show only eligible (ready to use) skills]" "(--verbose -v)"{--verbose,-v}"[Show more details including missing requirements]" "--agent[Target agent workspace (defaults to cwd-inferred, then default agent)]"
}
_openclaw_skills_search () {
	_arguments -C "--limit[Max results]" "--json[Output as JSON]"
}
_openclaw_skills_update () {
	_arguments -C "--all[Update all tracked ClawHub skills]" "--global[Update skills in the shared managed skills directory]" "--agent[Target agent workspace (defaults to cwd-inferred, then default agent)]"
}
_openclaw_status () {
	_arguments -C "--json[Output JSON instead of text]" "--all[Full diagnosis (read-only, pasteable)]" "--usage[Show model provider usage/quota snapshots]" "--deep[Probe channels (WhatsApp Web + Telegram + Discord + Slack + Signal)]" "--timeout[Probe timeout in milliseconds]" "--verbose[Verbose logging]" "--debug[Alias for --verbose]"
}
_openclaw_system () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'event[Enqueue a system event and optionally trigger a heartbeat]' 'heartbeat[Heartbeat controls]' 'presence[List system presence entries]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(event) _openclaw_system_event ;;
				(heartbeat) _openclaw_system_heartbeat ;;
				(presence) _openclaw_system_presence ;;
			esac ;;
	esac
}
_openclaw_system_event () {
	_arguments -C "--text[System event text]" "--mode[Wake mode (now|next-heartbeat)]" "--session-key[Target a specific session for the event (defaults to the agent'\''s main session)]" "--json[Output JSON]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--expect-final[Wait for final response (agent)]"
}
_openclaw_system_heartbeat () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'last[Show the last heartbeat event]' 'enable[Enable heartbeats]' 'disable[Disable heartbeats]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(last) _openclaw_system_heartbeat_last ;;
				(enable) _openclaw_system_heartbeat_enable ;;
				(disable) _openclaw_system_heartbeat_disable ;;
			esac ;;
	esac
}
_openclaw_system_heartbeat_disable () {
	_arguments -C "--json[Output JSON]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--expect-final[Wait for final response (agent)]"
}
_openclaw_system_heartbeat_enable () {
	_arguments -C "--json[Output JSON]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--expect-final[Wait for final response (agent)]"
}
_openclaw_system_heartbeat_last () {
	_arguments -C "--json[Output JSON]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--expect-final[Wait for final response (agent)]"
}
_openclaw_system_presence () {
	_arguments -C "--json[Output JSON]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--timeout[Timeout in ms]" "--expect-final[Wait for final response (agent)]"
}
_openclaw_tasks () {
	local -a commands
	local -a options
	_arguments -C "--json[Output as JSON]" "--runtime[Filter by kind (subagent, acp, cron, cli)]" "--status[Filter by status (queued, running, succeeded, failed, timed_out, cancelled, lost)]" "1: :_values 'command' 'list[List tracked background tasks]' 'audit[Show stale or broken background tasks and TaskFlows]' 'maintenance[Preview or apply tasks and TaskFlow maintenance]' 'show[Show one background task by task id, run id, or session key]' 'notify[Set task notify policy]' 'cancel[Cancel a running background task]' 'flow[Inspect durable TaskFlow state under tasks]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(list) _openclaw_tasks_list ;;
				(audit) _openclaw_tasks_audit ;;
				(maintenance) _openclaw_tasks_maintenance ;;
				(show) _openclaw_tasks_show ;;
				(notify) _openclaw_tasks_notify ;;
				(cancel) _openclaw_tasks_cancel ;;
				(flow) _openclaw_tasks_flow ;;
			esac ;;
	esac
}
_openclaw_tasks_audit () {
	_arguments -C "--json[Output as JSON]" "--severity[Filter by severity (warn, error)]" "--code[Filter by finding code (stale_queued, stale_running, lost, delivery_failed, missing_cleanup, inconsistent_timestamps, restore_failed, stale_waiting, stale_blocked, cancel_stuck, missing_linked_tasks, blocked_task_missing)]" "--limit[Limit displayed findings]"
}
_openclaw_tasks_cancel () {
	_arguments -C
}
_openclaw_tasks_flow () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'list[List tracked TaskFlows]' 'show[Show one TaskFlow by flow id or owner key]' 'cancel[Cancel a running TaskFlow]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(list) _openclaw_tasks_flow_list ;;
				(show) _openclaw_tasks_flow_show ;;
				(cancel) _openclaw_tasks_flow_cancel ;;
			esac ;;
	esac
}
_openclaw_tasks_flow_cancel () {
	_arguments -C
}
_openclaw_tasks_flow_list () {
	_arguments -C "--json[Output as JSON]" "--status[Filter by status (queued, running, waiting, blocked, succeeded, failed, cancelled, lost)]"
}
_openclaw_tasks_flow_show () {
	_arguments -C "--json[Output as JSON]"
}
_openclaw_tasks_list () {
	_arguments -C "--json[Output as JSON]" "--runtime[Filter by kind (subagent, acp, cron, cli)]" "--status[Filter by status (queued, running, succeeded, failed, timed_out, cancelled, lost)]"
}
_openclaw_tasks_maintenance () {
	_arguments -C "--json[Output as JSON]" "--apply[Apply reconciliation, cleanup stamping, and pruning]"
}
_openclaw_tasks_notify () {
	_arguments -C
}
_openclaw_tasks_show () {
	_arguments -C "--json[Output as JSON]"
}
_openclaw_tui () {
	_arguments -C "--local[Run against the local embedded agent runtime]" "--url[Gateway WebSocket URL (defaults to gateway.remote.url when configured)]" "--token[Gateway token (if required)]" "--password[Gateway password (if required)]" "--session[Session key (default: \"main\", or \"global\" when scope is global)]" "--deliver[Deliver assistant replies]" "--thinking[Thinking level override]" "--message[Send an initial message after connecting]" "--timeout-ms[Agent timeout in ms (defaults to agents.defaults.timeoutSeconds)]" "--history-limit[History entries to load]"
}
_openclaw_uninstall () {
	_arguments -C "--service[Remove the gateway service]" "--state[Remove state + config]" "--workspace[Remove workspace dirs]" "--app[Remove the macOS app]" "--all[Remove service + state + workspace + app]" "--yes[Skip confirmation prompts]" "--non-interactive[Disable prompts (requires --yes)]" "--dry-run[Print actions without removing files]"
}
_openclaw_update () {
	local -a commands
	local -a options
	_arguments -C "--json[Output result as JSON]" "--no-restart[Skip restarting the gateway service after a successful update]" "--dry-run[Preview update actions without making changes]" "--channel[Persist update channel (git + npm)]" "--tag[Override the package target for this update (dist-tag, version, or package spec)]" "--timeout[Timeout for each update step in seconds (default: 1800)]" "--yes[Skip confirmation prompts (non-interactive)]" "1: :_values 'command' 'finalize[Run OpenClaw update finalization after an external core runtime change]' 'wizard[Interactive update wizard]' 'status[Show update channel and version status]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(finalize) _openclaw_update_finalize ;;
				(wizard) _openclaw_update_wizard ;;
				(status) _openclaw_update_status ;;
			esac ;;
	esac
}
_openclaw_update_finalize () {
	_arguments -C "--json[Output result as JSON]" "--channel[Persist update channel for finalization]" "--timeout[Timeout for update finalization steps in seconds (default: 1800)]" "--yes[Skip confirmation prompts (non-interactive)]" "--no-restart[Accepted for update command parity; finalization never restarts]"
}
_openclaw_update_status () {
	_arguments -C "--json[Output result as JSON]" "--timeout[Timeout for update checks in seconds (default: 3)]"
}
_openclaw_update_wizard () {
	_arguments -C "--timeout[Timeout for each update step in seconds (default: 1800)]"
}
_openclaw_webhooks () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'gmail[Gmail Pub/Sub hooks (via gogcli)]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(gmail) _openclaw_webhooks_gmail ;;
			esac ;;
	esac
}
_openclaw_webhooks_gmail () {
	local -a commands
	local -a options
	_arguments -C "1: :_values 'command' 'setup[Configure Gmail watch + Pub/Sub + OpenClaw hooks]' 'run[Run gog watch serve + auto-renew loop]'" "*::arg:->args"
	case $state in
		(args) case $line[1] in
				(setup) _openclaw_webhooks_gmail_setup ;;
				(run) _openclaw_webhooks_gmail_run ;;
			esac ;;
	esac
}
_openclaw_webhooks_gmail_run () {
	_arguments -C "--account[Gmail account to watch]" "--topic[Pub/Sub topic path (projects/.../topics/..)]" "--subscription[Pub/Sub subscription name]" "--label[Gmail label to watch]" "--hook-url[OpenClaw hook URL]" "--hook-token[OpenClaw hook token]" "--push-token[Push token for gog watch serve]" "--bind[gog watch serve bind host]" "--port[gog watch serve port]" "--path[gog watch serve path]" "--include-body[Include email body snippets]" "--max-bytes[Max bytes for body snippets]" "--renew-minutes[Renew watch every N minutes]" "--tailscale[Expose push endpoint via tailscale (funnel|serve|off)]" "--tailscale-path[Path for tailscale serve/funnel]" "--tailscale-target[Tailscale serve/funnel target (port, host:port, or URL)]"
}
_openclaw_webhooks_gmail_setup () {
	_arguments -C "--account[Gmail account to watch]" "--project[GCP project id (OAuth client owner)]" "--topic[Pub/Sub topic name]" "--subscription[Pub/Sub subscription name]" "--label[Gmail label to watch]" "--hook-url[OpenClaw hook URL]" "--hook-token[OpenClaw hook token]" "--push-token[Push token for gog watch serve]" "--bind[gog watch serve bind host]" "--port[gog watch serve port]" "--path[gog watch serve path]" "--include-body[Include email body snippets]" "--max-bytes[Max bytes for body snippets]" "--renew-minutes[Renew watch every N minutes]" "--tailscale[Expose push endpoint via tailscale (funnel|serve|off)]" "--tailscale-path[Path for tailscale serve/funnel]" "--tailscale-target[Tailscale serve/funnel target (port, host:port, or URL)]" "--push-endpoint[Explicit Pub/Sub push endpoint]" "--json[Output JSON summary]"
}
_openstack () {
	# undefined
	builtin autoload -XUz
}
_opkg () {
	# undefined
	builtin autoload -XUz
}
_options () {
	# undefined
	builtin autoload -XUz
}
_options_set () {
	# undefined
	builtin autoload -XUz
}
_options_unset () {
	# undefined
	builtin autoload -XUz
}
_opustools () {
	# undefined
	builtin autoload -XUz
}
_osascript () {
	# undefined
	builtin autoload -XUz
}
_osc () {
	# undefined
	builtin autoload -XUz
}
_other_accounts () {
	# undefined
	builtin autoload -XUz
}
_otool () {
	# undefined
	builtin autoload -XUz
}
_pack () {
	# undefined
	builtin autoload -XUz
}
_pandoc () {
	# undefined
	builtin autoload -XUz
}
_parameter () {
	# undefined
	builtin autoload -XUz
}
_parameters () {
	# undefined
	builtin autoload -XUz
}
_paste () {
	# undefined
	builtin autoload -XUz
}
_patch () {
	# undefined
	builtin autoload -XUz
}
_patchutils () {
	# undefined
	builtin autoload -XUz
}
_path_commands () {
	# undefined
	builtin autoload -XUz
}
_path_files () {
	# undefined
	builtin autoload -XUz
}
_pax () {
	# undefined
	builtin autoload -XUz
}
_pbcopy () {
	# undefined
	builtin autoload -XUz
}
_pbm () {
	# undefined
	builtin autoload -XUz
}
_pbuilder () {
	# undefined
	builtin autoload -XUz
}
_pdf () {
	# undefined
	builtin autoload -XUz
}
_pdftk () {
	# undefined
	builtin autoload -XUz
}
_perf () {
	# undefined
	builtin autoload -XUz
}
_perforce () {
	# undefined
	builtin autoload -XUz
}
_perl () {
	# undefined
	builtin autoload -XUz
}
_perl_basepods () {
	# undefined
	builtin autoload -XUz
}
_perl_modules () {
	# undefined
	builtin autoload -XUz
}
_perldoc () {
	# undefined
	builtin autoload -XUz
}
_pfctl () {
	# undefined
	builtin autoload -XUz
}
_pfexec () {
	# undefined
	builtin autoload -XUz
}
_pgids () {
	# undefined
	builtin autoload -XUz
}
_pgrep () {
	# undefined
	builtin autoload -XUz
}
_php () {
	# undefined
	builtin autoload -XUz
}
_physical_volumes () {
	# undefined
	builtin autoload -XUz
}
_pick_variant () {
	# undefined
	builtin autoload -XUz
}
_picocom () {
	# undefined
	builtin autoload -XUz
}
_pidof () {
	# undefined
	builtin autoload -XUz
}
_pids () {
	# undefined
	builtin autoload -XUz
}
_pine () {
	# undefined
	builtin autoload -XUz
}
_ping () {
	# undefined
	builtin autoload -XUz
}
_pip () {
	# undefined
	builtin autoload -XUz
}
_piuparts () {
	# undefined
	builtin autoload -XUz
}
_pkg-config () {
	# undefined
	builtin autoload -XUz
}
_pkg5 () {
	# undefined
	builtin autoload -XUz
}
_pkg_instance () {
	# undefined
	builtin autoload -XUz
}
_pkgadd () {
	# undefined
	builtin autoload -XUz
}
_pkgin () {
	# undefined
	builtin autoload -XUz
}
_pkginfo () {
	# undefined
	builtin autoload -XUz
}
_pkgrm () {
	# undefined
	builtin autoload -XUz
}
_pkgtool () {
	# undefined
	builtin autoload -XUz
}
_plutil () {
	# undefined
	builtin autoload -XUz
}
_pmap () {
	# undefined
	builtin autoload -XUz
}
_pon () {
	# undefined
	builtin autoload -XUz
}
_portaudit () {
	# undefined
	builtin autoload -XUz
}
_portlint () {
	# undefined
	builtin autoload -XUz
}
_portmaster () {
	# undefined
	builtin autoload -XUz
}
_ports () {
	# undefined
	builtin autoload -XUz
}
_portsnap () {
	# undefined
	builtin autoload -XUz
}
_postfix () {
	# undefined
	builtin autoload -XUz
}
_postgresql () {
	# undefined
	builtin autoload -XUz
}
_postscript () {
	# undefined
	builtin autoload -XUz
}
_powerd () {
	# undefined
	builtin autoload -XUz
}
_pr () {
	# undefined
	builtin autoload -XUz
}
_precommand () {
	# undefined
	builtin autoload -XUz
}
_prefix () {
	# undefined
	builtin autoload -XUz
}
_print () {
	# undefined
	builtin autoload -XUz
}
_printenv () {
	# undefined
	builtin autoload -XUz
}
_printers () {
	# undefined
	builtin autoload -XUz
}
_process_names () {
	# undefined
	builtin autoload -XUz
}
_procstat () {
	# undefined
	builtin autoload -XUz
}
_prompt () {
	# undefined
	builtin autoload -XUz
}
_prove () {
	# undefined
	builtin autoload -XUz
}
_prstat () {
	# undefined
	builtin autoload -XUz
}
_ps () {
	# undefined
	builtin autoload -XUz
}
_ps1234 () {
	# undefined
	builtin autoload -XUz
}
_pscp () {
	# undefined
	builtin autoload -XUz
}
_pspdf () {
	# undefined
	builtin autoload -XUz
}
_psutils () {
	# undefined
	builtin autoload -XUz
}
_ptree () {
	# undefined
	builtin autoload -XUz
}
_ptx () {
	# undefined
	builtin autoload -XUz
}
_pump () {
	# undefined
	builtin autoload -XUz
}
_putclip () {
	# undefined
	builtin autoload -XUz
}
_pv () {
	# undefined
	builtin autoload -XUz
}
_pwgen () {
	# undefined
	builtin autoload -XUz
}
_pydoc () {
	# undefined
	builtin autoload -XUz
}
_python () {
	# undefined
	builtin autoload -XUz
}
_python_modules () {
	# undefined
	builtin autoload -XUz
}
_qdbus () {
	# undefined
	builtin autoload -XUz
}
_qemu () {
	# undefined
	builtin autoload -XUz
}
_qiv () {
	# undefined
	builtin autoload -XUz
}
_qtplay () {
	# undefined
	builtin autoload -XUz
}
_quilt () {
	# undefined
	builtin autoload -XUz
}
_rake () {
	# undefined
	builtin autoload -XUz
}
_ranlib () {
	# undefined
	builtin autoload -XUz
}
_rar () {
	# undefined
	builtin autoload -XUz
}
_rcctl () {
	# undefined
	builtin autoload -XUz
}
_rclone () {
	# undefined
	builtin autoload -XUz
}
_rcs () {
	# undefined
	builtin autoload -XUz
}
_rdesktop () {
	# undefined
	builtin autoload -XUz
}
_read () {
	# undefined
	builtin autoload -XUz
}
_read_comp () {
	# undefined
	builtin autoload -XUz
}
_readelf () {
	# undefined
	builtin autoload -XUz
}
_readlink () {
	# undefined
	builtin autoload -XUz
}
_readshortcut () {
	# undefined
	builtin autoload -XUz
}
_rebootin () {
	# undefined
	builtin autoload -XUz
}
_redirect () {
	# undefined
	builtin autoload -XUz
}
_regex_arguments () {
	# undefined
	builtin autoload -XUz
}
_regex_words () {
	# undefined
	builtin autoload -XUz
}
_remote_files () {
	# undefined
	builtin autoload -XUz
}
_renice () {
	# undefined
	builtin autoload -XUz
}
_reprepro () {
	# undefined
	builtin autoload -XUz
}
_requested () {
	# undefined
	builtin autoload -XUz
}
_retrieve_cache () {
	# undefined
	builtin autoload -XUz
}
_retrieve_mac_apps () {
	# undefined
	builtin autoload -XUz
}
_ri () {
	# undefined
	builtin autoload -XUz
}
_rlogin () {
	# undefined
	builtin autoload -XUz
}
_rm () {
	# undefined
	builtin autoload -XUz
}
_rmdir () {
	# undefined
	builtin autoload -XUz
}
_route () {
	# undefined
	builtin autoload -XUz
}
_routing_domains () {
	# undefined
	builtin autoload -XUz
}
_routing_tables () {
	# undefined
	builtin autoload -XUz
}
_rpm () {
	# undefined
	builtin autoload -XUz
}
_rrdtool () {
	# undefined
	builtin autoload -XUz
}
_rsync () {
	# undefined
	builtin autoload -XUz
}
_rubber () {
	# undefined
	builtin autoload -XUz
}
_ruby () {
	# undefined
	builtin autoload -XUz
}
_run-help () {
	# undefined
	builtin autoload -XUz
}
_runit () {
	# undefined
	builtin autoload -XUz
}
_samba () {
	# undefined
	builtin autoload -XUz
}
_savecore () {
	# undefined
	builtin autoload -XUz
}
_say () {
	# undefined
	builtin autoload -XUz
}
_sbuild () {
	# undefined
	builtin autoload -XUz
}
_sc_usage () {
	# undefined
	builtin autoload -XUz
}
_sccs () {
	# undefined
	builtin autoload -XUz
}
_sched () {
	# undefined
	builtin autoload -XUz
}
_schedtool () {
	# undefined
	builtin autoload -XUz
}
_schroot () {
	# undefined
	builtin autoload -XUz
}
_scl () {
	# undefined
	builtin autoload -XUz
}
_scons () {
	# undefined
	builtin autoload -XUz
}
_screen () {
	# undefined
	builtin autoload -XUz
}
_script () {
	# undefined
	builtin autoload -XUz
}
_scselect () {
	# undefined
	builtin autoload -XUz
}
_scutil () {
	# undefined
	builtin autoload -XUz
}
_seafile () {
	# undefined
	builtin autoload -XUz
}
_sed () {
	# undefined
	builtin autoload -XUz
}
_selinux_contexts () {
	# undefined
	builtin autoload -XUz
}
_selinux_roles () {
	# undefined
	builtin autoload -XUz
}
_selinux_types () {
	# undefined
	builtin autoload -XUz
}
_selinux_users () {
	# undefined
	builtin autoload -XUz
}
_sep_parts () {
	# undefined
	builtin autoload -XUz
}
_seq () {
	# undefined
	builtin autoload -XUz
}
_sequence () {
	# undefined
	builtin autoload -XUz
}
_service () {
	# undefined
	builtin autoload -XUz
}
_services () {
	# undefined
	builtin autoload -XUz
}
_set () {
	# undefined
	builtin autoload -XUz
}
_set_command () {
	# undefined
	builtin autoload -XUz
}
_setfacl () {
	# undefined
	builtin autoload -XUz
}
_setopt () {
	# undefined
	builtin autoload -XUz
}
_setpriv () {
	# undefined
	builtin autoload -XUz
}
_setsid () {
	# undefined
	builtin autoload -XUz
}
_setup () {
	# undefined
	builtin autoload -XUz
}
_setxkbmap () {
	# undefined
	builtin autoload -XUz
}
_sh () {
	# undefined
	builtin autoload -XUz
}
_shasum () {
	# undefined
	builtin autoload -XUz
}
_showmount () {
	# undefined
	builtin autoload -XUz
}
_shred () {
	# undefined
	builtin autoload -XUz
}
_shuf () {
	# undefined
	builtin autoload -XUz
}
_shutdown () {
	# undefined
	builtin autoload -XUz
}
_signals () {
	# undefined
	builtin autoload -XUz
}
_signify () {
	# undefined
	builtin autoload -XUz
}
_sisu () {
	# undefined
	builtin autoload -XUz
}
_slabtop () {
	# undefined
	builtin autoload -XUz
}
_slrn () {
	# undefined
	builtin autoload -XUz
}
_smartmontools () {
	# undefined
	builtin autoload -XUz
}
_smit () {
	# undefined
	builtin autoload -XUz
}
_snoop () {
	# undefined
	builtin autoload -XUz
}
_socket () {
	# undefined
	builtin autoload -XUz
}
_sockstat () {
	# undefined
	builtin autoload -XUz
}
_softwareupdate () {
	# undefined
	builtin autoload -XUz
}
_sort () {
	# undefined
	builtin autoload -XUz
}
_source () {
	# undefined
	builtin autoload -XUz
}
_spamassassin () {
	# undefined
	builtin autoload -XUz
}
_split () {
	# undefined
	builtin autoload -XUz
}
_sqlite () {
	# undefined
	builtin autoload -XUz
}
_sqsh () {
	# undefined
	builtin autoload -XUz
}
_ss () {
	# undefined
	builtin autoload -XUz
}
_ssh () {
	# undefined
	builtin autoload -XUz
}
_ssh_hosts () {
	# undefined
	builtin autoload -XUz
}
_sshfs () {
	# undefined
	builtin autoload -XUz
}
_stat () {
	# undefined
	builtin autoload -XUz
}
_stdbuf () {
	# undefined
	builtin autoload -XUz
}
_stgit () {
	# undefined
	builtin autoload -XUz
}
_store_cache () {
	# undefined
	builtin autoload -XUz
}
_stow () {
	# undefined
	builtin autoload -XUz
}
_strace () {
	# undefined
	builtin autoload -XUz
}
_strftime () {
	# undefined
	builtin autoload -XUz
}
_strings () {
	# undefined
	builtin autoload -XUz
}
_strip () {
	# undefined
	builtin autoload -XUz
}
_stty () {
	# undefined
	builtin autoload -XUz
}
_su () {
	# undefined
	builtin autoload -XUz
}
_sub_commands () {
	# undefined
	builtin autoload -XUz
}
_sublimetext () {
	# undefined
	builtin autoload -XUz
}
_subscript () {
	# undefined
	builtin autoload -XUz
}
_subversion () {
	# undefined
	builtin autoload -XUz
}
_sudo () {
	# undefined
	builtin autoload -XUz
}
_suffix_alias_files () {
	# undefined
	builtin autoload -XUz
}
_surfraw () {
	# undefined
	builtin autoload -XUz
}
_svcadm () {
	# undefined
	builtin autoload -XUz
}
_svccfg () {
	# undefined
	builtin autoload -XUz
}
_svcprop () {
	# undefined
	builtin autoload -XUz
}
_svcs () {
	# undefined
	builtin autoload -XUz
}
_svcs_fmri () {
	# undefined
	builtin autoload -XUz
}
_svn-buildpackage () {
	# undefined
	builtin autoload -XUz
}
_sw_vers () {
	# undefined
	builtin autoload -XUz
}
_swaks () {
	# undefined
	builtin autoload -XUz
}
_swanctl () {
	# undefined
	builtin autoload -XUz
}
_swift () {
	# undefined
	builtin autoload -XUz
}
_sys_calls () {
	# undefined
	builtin autoload -XUz
}
_sysclean () {
	# undefined
	builtin autoload -XUz
}
_sysctl () {
	# undefined
	builtin autoload -XUz
}
_sysmerge () {
	# undefined
	builtin autoload -XUz
}
_syspatch () {
	# undefined
	builtin autoload -XUz
}
_sysrc () {
	# undefined
	builtin autoload -XUz
}
_sysstat () {
	# undefined
	builtin autoload -XUz
}
_systat () {
	# undefined
	builtin autoload -XUz
}
_system_profiler () {
	# undefined
	builtin autoload -XUz
}
_sysupgrade () {
	# undefined
	builtin autoload -XUz
}
_tac () {
	# undefined
	builtin autoload -XUz
}
_tags () {
	# undefined
	builtin autoload -XUz
}
_tail () {
	# undefined
	builtin autoload -XUz
}
_tar () {
	# undefined
	builtin autoload -XUz
}
_tar_archive () {
	# undefined
	builtin autoload -XUz
}
_tardy () {
	# undefined
	builtin autoload -XUz
}
_tcpdump () {
	# undefined
	builtin autoload -XUz
}
_tcpsys () {
	# undefined
	builtin autoload -XUz
}
_tcptraceroute () {
	# undefined
	builtin autoload -XUz
}
_tee () {
	# undefined
	builtin autoload -XUz
}
_telnet () {
	# undefined
	builtin autoload -XUz
}
_terminals () {
	# undefined
	builtin autoload -XUz
}
_tex () {
	# undefined
	builtin autoload -XUz
}
_texi () {
	# undefined
	builtin autoload -XUz
}
_texinfo () {
	# undefined
	builtin autoload -XUz
}
_tidy () {
	# undefined
	builtin autoload -XUz
}
_tiff () {
	# undefined
	builtin autoload -XUz
}
_tilde () {
	# undefined
	builtin autoload -XUz
}
_tilde_files () {
	# undefined
	builtin autoload -XUz
}
_time_zone () {
	# undefined
	builtin autoload -XUz
}
_timeout () {
	# undefined
	builtin autoload -XUz
}
_tin () {
	# undefined
	builtin autoload -XUz
}
_tla () {
	# undefined
	builtin autoload -XUz
}
_tload () {
	# undefined
	builtin autoload -XUz
}
_tmux () {
	# undefined
	builtin autoload -XUz
}
_todo.sh () {
	# undefined
	builtin autoload -XUz
}
_toilet () {
	# undefined
	builtin autoload -XUz
}
_toolchain-source () {
	# undefined
	builtin autoload -XUz
}
_top () {
	# undefined
	builtin autoload -XUz
}
_topgit () {
	# undefined
	builtin autoload -XUz
}
_totd () {
	# undefined
	builtin autoload -XUz
}
_touch () {
	# undefined
	builtin autoload -XUz
}
_tpb () {
	# undefined
	builtin autoload -XUz
}
_tput () {
	# undefined
	builtin autoload -XUz
}
_tr () {
	# undefined
	builtin autoload -XUz
}
_tracepath () {
	# undefined
	builtin autoload -XUz
}
_transmission () {
	# undefined
	builtin autoload -XUz
}
_trap () {
	# undefined
	builtin autoload -XUz
}
_trash () {
	# undefined
	builtin autoload -XUz
}
_tree () {
	# undefined
	builtin autoload -XUz
}
_truncate () {
	# undefined
	builtin autoload -XUz
}
_truss () {
	# undefined
	builtin autoload -XUz
}
_tty () {
	# undefined
	builtin autoload -XUz
}
_ttyctl () {
	# undefined
	builtin autoload -XUz
}
_ttys () {
	# undefined
	builtin autoload -XUz
}
_tune2fs () {
	# undefined
	builtin autoload -XUz
}
_twidge () {
	# undefined
	builtin autoload -XUz
}
_twisted () {
	# undefined
	builtin autoload -XUz
}
_typeset () {
	# undefined
	builtin autoload -XUz
}
_ulimit () {
	# undefined
	builtin autoload -XUz
}
_uml () {
	# undefined
	builtin autoload -XUz
}
_umountable () {
	# undefined
	builtin autoload -XUz
}
_unace () {
	# undefined
	builtin autoload -XUz
}
_uname () {
	# undefined
	builtin autoload -XUz
}
_unexpand () {
	# undefined
	builtin autoload -XUz
}
_unhash () {
	# undefined
	builtin autoload -XUz
}
_uniq () {
	# undefined
	builtin autoload -XUz
}
_unison () {
	# undefined
	builtin autoload -XUz
}
_units () {
	# undefined
	builtin autoload -XUz
}
_unshare () {
	# undefined
	builtin autoload -XUz
}
_update-alternatives () {
	# undefined
	builtin autoload -XUz
}
_update-rc.d () {
	# undefined
	builtin autoload -XUz
}
_uptime () {
	# undefined
	builtin autoload -XUz
}
_urls () {
	# undefined
	builtin autoload -XUz
}
_urpmi () {
	# undefined
	builtin autoload -XUz
}
_urxvt () {
	# undefined
	builtin autoload -XUz
}
_usbconfig () {
	# undefined
	builtin autoload -XUz
}
_uscan () {
	# undefined
	builtin autoload -XUz
}
_user_admin () {
	# undefined
	builtin autoload -XUz
}
_user_at_host () {
	# undefined
	builtin autoload -XUz
}
_user_expand () {
	# undefined
	builtin autoload -XUz
}
_user_math_func () {
	# undefined
	builtin autoload -XUz
}
_users () {
	# undefined
	builtin autoload -XUz
}
_users_on () {
	# undefined
	builtin autoload -XUz
}
_valgrind () {
	# undefined
	builtin autoload -XUz
}
_value () {
	# undefined
	builtin autoload -XUz
}
_values () {
	# undefined
	builtin autoload -XUz
}
_vared () {
	# undefined
	builtin autoload -XUz
}
_vars () {
	# undefined
	builtin autoload -XUz
}
_vcs_info () {
	# undefined
	builtin autoload -XUz
}
_vcs_info_hooks () {
	# undefined
	builtin autoload -XUz
}
_vi () {
	# undefined
	builtin autoload -XUz
}
_vim () {
	# undefined
	builtin autoload -XUz
}
_vim-addons () {
	# undefined
	builtin autoload -XUz
}
_visudo () {
	# undefined
	builtin autoload -XUz
}
_vmctl () {
	# undefined
	builtin autoload -XUz
}
_vmstat () {
	# undefined
	builtin autoload -XUz
}
_vnc () {
	# undefined
	builtin autoload -XUz
}
_volume_groups () {
	# undefined
	builtin autoload -XUz
}
_vorbis () {
	# undefined
	builtin autoload -XUz
}
_vpnc () {
	# undefined
	builtin autoload -XUz
}
_vserver () {
	# undefined
	builtin autoload -XUz
}
_w () {
	# undefined
	builtin autoload -XUz
}
_w3m () {
	# undefined
	builtin autoload -XUz
}
_wait () {
	# undefined
	builtin autoload -XUz
}
_wajig () {
	# undefined
	builtin autoload -XUz
}
_wakeup_capable_devices () {
	# undefined
	builtin autoload -XUz
}
_wanna-build () {
	# undefined
	builtin autoload -XUz
}
_wanted () {
	# undefined
	builtin autoload -XUz
}
_watch () {
	# undefined
	builtin autoload -XUz
}
_watch-snoop () {
	# undefined
	builtin autoload -XUz
}
_wc () {
	# undefined
	builtin autoload -XUz
}
_webbrowser () {
	# undefined
	builtin autoload -XUz
}
_wget () {
	# undefined
	builtin autoload -XUz
}
_whereis () {
	# undefined
	builtin autoload -XUz
}
_which () {
	# undefined
	builtin autoload -XUz
}
_who () {
	# undefined
	builtin autoload -XUz
}
_whois () {
	# undefined
	builtin autoload -XUz
}
_widgets () {
	# undefined
	builtin autoload -XUz
}
_wiggle () {
	# undefined
	builtin autoload -XUz
}
_wipefs () {
	# undefined
	builtin autoload -XUz
}
_wpa_cli () {
	# undefined
	builtin autoload -XUz
}
_x_arguments () {
	# undefined
	builtin autoload -XUz
}
_x_borderwidth () {
	# undefined
	builtin autoload -XUz
}
_x_color () {
	# undefined
	builtin autoload -XUz
}
_x_colormapid () {
	# undefined
	builtin autoload -XUz
}
_x_cursor () {
	# undefined
	builtin autoload -XUz
}
_x_display () {
	# undefined
	builtin autoload -XUz
}
_x_extension () {
	# undefined
	builtin autoload -XUz
}
_x_font () {
	# undefined
	builtin autoload -XUz
}
_x_geometry () {
	# undefined
	builtin autoload -XUz
}
_x_keysym () {
	# undefined
	builtin autoload -XUz
}
_x_locale () {
	# undefined
	builtin autoload -XUz
}
_x_modifier () {
	# undefined
	builtin autoload -XUz
}
_x_name () {
	# undefined
	builtin autoload -XUz
}
_x_resource () {
	# undefined
	builtin autoload -XUz
}
_x_selection_timeout () {
	# undefined
	builtin autoload -XUz
}
_x_title () {
	# undefined
	builtin autoload -XUz
}
_x_utils () {
	# undefined
	builtin autoload -XUz
}
_x_visual () {
	# undefined
	builtin autoload -XUz
}
_x_window () {
	# undefined
	builtin autoload -XUz
}
_xargs () {
	# undefined
	builtin autoload -XUz
}
_xauth () {
	# undefined
	builtin autoload -XUz
}
_xautolock () {
	# undefined
	builtin autoload -XUz
}
_xclip () {
	# undefined
	builtin autoload -XUz
}
_xcode-select () {
	# undefined
	builtin autoload -XUz
}
_xdvi () {
	# undefined
	builtin autoload -XUz
}
_xfig () {
	# undefined
	builtin autoload -XUz
}
_xft_fonts () {
	# undefined
	builtin autoload -XUz
}
_xinput () {
	# undefined
	builtin autoload -XUz
}
_xloadimage () {
	# undefined
	builtin autoload -XUz
}
_xmlsoft () {
	# undefined
	builtin autoload -XUz
}
_xmlstarlet () {
	# undefined
	builtin autoload -XUz
}
_xmms2 () {
	# undefined
	builtin autoload -XUz
}
_xmodmap () {
	# undefined
	builtin autoload -XUz
}
_xournal () {
	# undefined
	builtin autoload -XUz
}
_xpdf () {
	# undefined
	builtin autoload -XUz
}
_xrandr () {
	# undefined
	builtin autoload -XUz
}
_xscreensaver () {
	# undefined
	builtin autoload -XUz
}
_xset () {
	# undefined
	builtin autoload -XUz
}
_xt_arguments () {
	# undefined
	builtin autoload -XUz
}
_xt_session_id () {
	# undefined
	builtin autoload -XUz
}
_xterm () {
	# undefined
	builtin autoload -XUz
}
_xv () {
	# undefined
	builtin autoload -XUz
}
_xwit () {
	# undefined
	builtin autoload -XUz
}
_xxd () {
	# undefined
	builtin autoload -XUz
}
_xz () {
	# undefined
	builtin autoload -XUz
}
_yafc () {
	# undefined
	builtin autoload -XUz
}
_yast () {
	# undefined
	builtin autoload -XUz
}
_yodl () {
	# undefined
	builtin autoload -XUz
}
_yp () {
	# undefined
	builtin autoload -XUz
}
_yum () {
	# undefined
	builtin autoload -XUz
}
_zargs () {
	# undefined
	builtin autoload -XUz
}
_zattr () {
	# undefined
	builtin autoload -XUz
}
_zcalc () {
	# undefined
	builtin autoload -XUz
}
_zcalc_line () {
	# undefined
	builtin autoload -XUz
}
_zcat () {
	# undefined
	builtin autoload -XUz
}
_zcompile () {
	# undefined
	builtin autoload -XUz
}
_zdump () {
	# undefined
	builtin autoload -XUz
}
_zeal () {
	# undefined
	builtin autoload -XUz
}
_zed () {
	# undefined
	builtin autoload -XUz
}
_zfs () {
	# undefined
	builtin autoload -XUz
}
_zfs_dataset () {
	# undefined
	builtin autoload -XUz
}
_zfs_pool () {
	# undefined
	builtin autoload -XUz
}
_zftp () {
	# undefined
	builtin autoload -XUz
}
_zip () {
	# undefined
	builtin autoload -XUz
}
_zle () {
	# undefined
	builtin autoload -XUz
}
_zlogin () {
	# undefined
	builtin autoload -XUz
}
_zmodload () {
	# undefined
	builtin autoload -XUz
}
_zmv () {
	# undefined
	builtin autoload -XUz
}
_zoneadm () {
	# undefined
	builtin autoload -XUz
}
_zones () {
	# undefined
	builtin autoload -XUz
}
_zparseopts () {
	# undefined
	builtin autoload -XUz
}
_zpty () {
	# undefined
	builtin autoload -XUz
}
_zsh () {
	# undefined
	builtin autoload -XUz
}
_zsh-mime-handler () {
	# undefined
	builtin autoload -XUz
}
_zsocket () {
	# undefined
	builtin autoload -XUz
}
_zstyle () {
	# undefined
	builtin autoload -XUz
}
_ztodo () {
	# undefined
	builtin autoload -XUz
}
_zypper () {
	# undefined
	builtin autoload -XUz
}
add-zsh-hook () {
	emulate -L zsh
	local -a hooktypes
	hooktypes=(chpwd precmd preexec periodic zshaddhistory zshexit zsh_directory_name) 
	local usage="Usage: add-zsh-hook hook function\nValid hooks are:\n  $hooktypes" 
	local opt
	local -a autoopts
	integer del list help
	while getopts "dDhLUzk" opt
	do
		case $opt in
			(d) del=1  ;;
			(D) del=2  ;;
			(h) help=1  ;;
			(L) list=1  ;;
			([Uzk]) autoopts+=(-$opt)  ;;
			(*) return 1 ;;
		esac
	done
	shift $(( OPTIND - 1 ))
	if (( list ))
	then
		typeset -mp "(${1:-${(@j:|:)hooktypes}})_functions"
		return $?
	elif (( help || $# != 2 || ${hooktypes[(I)$1]} == 0 ))
	then
		print -u$(( 2 - help )) $usage
		return $(( 1 - help ))
	fi
	local hook="${1}_functions" 
	local fn="$2" 
	if (( del ))
	then
		if (( ${(P)+hook} ))
		then
			if (( del == 2 ))
			then
				set -A $hook ${(P)hook:#${~fn}}
			else
				set -A $hook ${(P)hook:#$fn}
			fi
			if (( ! ${(P)#hook} ))
			then
				unset $hook
			fi
		fi
	else
		if (( ${(P)+hook} ))
		then
			if (( ${${(P)hook}[(I)$fn]} == 0 ))
			then
				typeset -ga $hook
				set -A $hook ${(P)hook} $fn
			fi
		else
			typeset -ga $hook
			set -A $hook $fn
		fi
		autoload $autoopts -- $fn
	fi
}
alias_value () {
	(( $+aliases[$1] )) && echo $aliases[$1]
}
azure_prompt_info () {
	return 1
}
bashcompinit () {
	# undefined
	builtin autoload -XUz
}
bracketed-paste-magic () {
	# undefined
	builtin autoload -XUz
}
bzr_prompt_info () {
	local bzr_branch
	bzr_branch=$(bzr nick 2>/dev/null)  || return
	if [[ -n "$bzr_branch" ]]
	then
		local bzr_dirty="" 
		if [[ -n $(bzr status 2>/dev/null) ]]
		then
			bzr_dirty=" %{$fg[red]%}*%{$reset_color%}" 
		fi
		printf "%s%s%s%s" "$ZSH_THEME_SCM_PROMPT_PREFIX" "bzr::${bzr_branch##*:}" "$bzr_dirty" "$ZSH_THEME_GIT_PROMPT_SUFFIX"
	fi
}
chruby_prompt_info () {
	return 1
}
clipcopy () {
	unfunction clipcopy clippaste
	detect-clipboard || true
	"$0" "$@"
}
clippaste () {
	unfunction clipcopy clippaste
	detect-clipboard || true
	"$0" "$@"
}
colors () {
	emulate -L zsh
	typeset -Ag color colour
	color=(00 none 01 bold 02 faint 22 normal 03 italic 23 no-italic 04 underline 24 no-underline 05 blink 25 no-blink 07 reverse 27 no-reverse 08 conceal 28 no-conceal 30 black 40 bg-black 31 red 41 bg-red 32 green 42 bg-green 33 yellow 43 bg-yellow 34 blue 44 bg-blue 35 magenta 45 bg-magenta 36 cyan 46 bg-cyan 37 white 47 bg-white 39 default 49 bg-default) 
	local k
	for k in ${(k)color}
	do
		color[${color[$k]}]=$k 
	done
	for k in ${color[(I)3?]}
	do
		color[fg-${color[$k]}]=$k 
	done
	for k in grey gray
	do
		color[$k]=${color[black]} 
		color[fg-$k]=${color[$k]} 
		color[bg-$k]=${color[bg-black]} 
	done
	colour=(${(kv)color}) 
	local lc=$'\e[' rc=m 
	typeset -Hg reset_color bold_color
	reset_color="$lc${color[none]}$rc" 
	bold_color="$lc${color[bold]}$rc" 
	typeset -AHg fg fg_bold fg_no_bold
	for k in ${(k)color[(I)fg-*]}
	do
		fg[${k#fg-}]="$lc${color[$k]}$rc" 
		fg_bold[${k#fg-}]="$lc${color[bold]};${color[$k]}$rc" 
		fg_no_bold[${k#fg-}]="$lc${color[normal]};${color[$k]}$rc" 
	done
	typeset -AHg bg bg_bold bg_no_bold
	for k in ${(k)color[(I)bg-*]}
	do
		bg[${k#bg-}]="$lc${color[$k]}$rc" 
		bg_bold[${k#bg-}]="$lc${color[bold]};${color[$k]}$rc" 
		bg_no_bold[${k#bg-}]="$lc${color[normal]};${color[$k]}$rc" 
	done
}
compaudit () {
	# undefined
	builtin autoload -XUz /usr/share/zsh/5.9/functions
}
compdef () {
	local opt autol type func delete eval new i ret=0 cmd svc 
	local -a match mbegin mend
	emulate -L zsh
	setopt extendedglob
	if (( ! $# ))
	then
		print -u2 "$0: I need arguments"
		return 1
	fi
	while getopts "anpPkKde" opt
	do
		case "$opt" in
			(a) autol=yes  ;;
			(n) new=yes  ;;
			([pPkK]) if [[ -n "$type" ]]
				then
					print -u2 "$0: type already set to $type"
					return 1
				fi
				if [[ "$opt" = p ]]
				then
					type=pattern 
				elif [[ "$opt" = P ]]
				then
					type=postpattern 
				elif [[ "$opt" = K ]]
				then
					type=widgetkey 
				else
					type=key 
				fi ;;
			(d) delete=yes  ;;
			(e) eval=yes  ;;
		esac
	done
	shift OPTIND-1
	if (( ! $# ))
	then
		print -u2 "$0: I need arguments"
		return 1
	fi
	if [[ -z "$delete" ]]
	then
		if [[ -z "$eval" ]] && [[ "$1" = *\=* ]]
		then
			while (( $# ))
			do
				if [[ "$1" = *\=* ]]
				then
					cmd="${1%%\=*}" 
					svc="${1#*\=}" 
					func="$_comps[${_services[(r)$svc]:-$svc}]" 
					[[ -n ${_services[$svc]} ]] && svc=${_services[$svc]} 
					[[ -z "$func" ]] && func="${${_patcomps[(K)$svc][1]}:-${_postpatcomps[(K)$svc][1]}}" 
					if [[ -n "$func" ]]
					then
						_comps[$cmd]="$func" 
						_services[$cmd]="$svc" 
					else
						print -u2 "$0: unknown command or service: $svc"
						ret=1 
					fi
				else
					print -u2 "$0: invalid argument: $1"
					ret=1 
				fi
				shift
			done
			return ret
		fi
		func="$1" 
		[[ -n "$autol" ]] && autoload -rUz "$func"
		shift
		case "$type" in
			(widgetkey) while [[ -n $1 ]]
				do
					if [[ $# -lt 3 ]]
					then
						print -u2 "$0: compdef -K requires <widget> <comp-widget> <key>"
						return 1
					fi
					[[ $1 = _* ]] || 1="_$1" 
					[[ $2 = .* ]] || 2=".$2" 
					[[ $2 = .menu-select ]] && zmodload -i zsh/complist
					zle -C "$1" "$2" "$func"
					if [[ -n $new ]]
					then
						bindkey "$3" | IFS=$' \t' read -A opt
						[[ $opt[-1] = undefined-key ]] && bindkey "$3" "$1"
					else
						bindkey "$3" "$1"
					fi
					shift 3
				done ;;
			(key) if [[ $# -lt 2 ]]
				then
					print -u2 "$0: missing keys"
					return 1
				fi
				if [[ $1 = .* ]]
				then
					[[ $1 = .menu-select ]] && zmodload -i zsh/complist
					zle -C "$func" "$1" "$func"
				else
					[[ $1 = menu-select ]] && zmodload -i zsh/complist
					zle -C "$func" ".$1" "$func"
				fi
				shift
				for i
				do
					if [[ -n $new ]]
					then
						bindkey "$i" | IFS=$' \t' read -A opt
						[[ $opt[-1] = undefined-key ]] || continue
					fi
					bindkey "$i" "$func"
				done ;;
			(*) while (( $# ))
				do
					if [[ "$1" = -N ]]
					then
						type=normal 
					elif [[ "$1" = -p ]]
					then
						type=pattern 
					elif [[ "$1" = -P ]]
					then
						type=postpattern 
					else
						case "$type" in
							(pattern) if [[ $1 = (#b)(*)=(*) ]]
								then
									_patcomps[$match[1]]="=$match[2]=$func" 
								else
									_patcomps[$1]="$func" 
								fi ;;
							(postpattern) if [[ $1 = (#b)(*)=(*) ]]
								then
									_postpatcomps[$match[1]]="=$match[2]=$func" 
								else
									_postpatcomps[$1]="$func" 
								fi ;;
							(*) if [[ "$1" = *\=* ]]
								then
									cmd="${1%%\=*}" 
									svc=yes 
								else
									cmd="$1" 
									svc= 
								fi
								if [[ -z "$new" || -z "${_comps[$1]}" ]]
								then
									_comps[$cmd]="$func" 
									[[ -n "$svc" ]] && _services[$cmd]="${1#*\=}" 
								fi ;;
						esac
					fi
					shift
				done ;;
		esac
	else
		case "$type" in
			(pattern) unset "_patcomps[$^@]" ;;
			(postpattern) unset "_postpatcomps[$^@]" ;;
			(key) print -u2 "$0: cannot restore key bindings"
				return 1 ;;
			(*) unset "_comps[$^@]" ;;
		esac
	fi
}
compdump () {
	# undefined
	builtin autoload -XUz /usr/share/zsh/5.9/functions
}
compgen () {
	local opts prefix suffix job OPTARG OPTIND ret=1 
	local -a name res results jids
	local -A shortopts
	emulate -L sh
	setopt kshglob noshglob braceexpand nokshautoload
	shortopts=(a alias b builtin c command d directory e export f file g group j job k keyword u user v variable) 
	while getopts "o:A:G:C:F:P:S:W:X:abcdefgjkuv" name
	do
		case $name in
			([abcdefgjkuv]) OPTARG="${shortopts[$name]}"  ;&
			(A) case $OPTARG in
					(alias) results+=("${(k)aliases[@]}")  ;;
					(arrayvar) results+=("${(k@)parameters[(R)array*]}")  ;;
					(binding) results+=("${(k)widgets[@]}")  ;;
					(builtin) results+=("${(k)builtins[@]}" "${(k)dis_builtins[@]}")  ;;
					(command) results+=("${(k)commands[@]}" "${(k)aliases[@]}" "${(k)builtins[@]}" "${(k)functions[@]}" "${(k)reswords[@]}")  ;;
					(directory) setopt bareglobqual
						results+=(${IPREFIX}${PREFIX}*${SUFFIX}${ISUFFIX}(N-/)) 
						setopt nobareglobqual ;;
					(disabled) results+=("${(k)dis_builtins[@]}")  ;;
					(enabled) results+=("${(k)builtins[@]}")  ;;
					(export) results+=("${(k)parameters[(R)*export*]}")  ;;
					(file) setopt bareglobqual
						results+=(${IPREFIX}${PREFIX}*${SUFFIX}${ISUFFIX}(N)) 
						setopt nobareglobqual ;;
					(function) results+=("${(k)functions[@]}")  ;;
					(group) emulate zsh
						_groups -U -O res
						emulate sh
						setopt kshglob noshglob braceexpand
						results+=("${res[@]}")  ;;
					(hostname) emulate zsh
						_hosts -U -O res
						emulate sh
						setopt kshglob noshglob braceexpand
						results+=("${res[@]}")  ;;
					(job) results+=("${savejobtexts[@]%% *}")  ;;
					(keyword) results+=("${(k)reswords[@]}")  ;;
					(running) jids=("${(@k)savejobstates[(R)running*]}") 
						for job in "${jids[@]}"
						do
							results+=(${savejobtexts[$job]%% *}) 
						done ;;
					(stopped) jids=("${(@k)savejobstates[(R)suspended*]}") 
						for job in "${jids[@]}"
						do
							results+=(${savejobtexts[$job]%% *}) 
						done ;;
					(setopt | shopt) results+=("${(k)options[@]}")  ;;
					(signal) results+=("SIG${^signals[@]}")  ;;
					(user) results+=("${(k)userdirs[@]}")  ;;
					(variable) results+=("${(k)parameters[@]}")  ;;
					(helptopic)  ;;
				esac ;;
			(F) COMPREPLY=() 
				local -a args
				args=("${words[0]}" "${@[-1]}" "${words[CURRENT-2]}") 
				() {
					typeset -h words
					$OPTARG "${args[@]}"
				}
				results+=("${COMPREPLY[@]}")  ;;
			(G) setopt nullglob
				results+=(${~OPTARG}) 
				unsetopt nullglob ;;
			(W) results+=(${(Q)~=OPTARG})  ;;
			(C) results+=($(eval $OPTARG))  ;;
			(P) prefix="$OPTARG"  ;;
			(S) suffix="$OPTARG"  ;;
			(X) if [[ ${OPTARG[0]} = '!' ]]
				then
					results=("${(M)results[@]:#${OPTARG#?}}") 
				else
					results=("${results[@]:#$OPTARG}") 
				fi ;;
		esac
	done
	print -l -r -- "$prefix${^results[@]}$suffix"
}
compinit () {
	# undefined
	builtin autoload -XUz /usr/share/zsh/5.9/functions
}
compinstall () {
	# undefined
	builtin autoload -XUz /usr/share/zsh/5.9/functions
}
complete () {
	emulate -L zsh
	local args void cmd print remove
	args=("$@") 
	zparseopts -D -a void o: A: G: W: C: F: P: S: X: a b c d e f g j k u v p=print r=remove
	if [[ -n $print ]]
	then
		printf 'complete %2$s %1$s\n' "${(@kv)_comps[(R)_bash*]#* }"
	elif [[ -n $remove ]]
	then
		for cmd
		do
			unset "_comps[$cmd]"
		done
	else
		compdef _bash_complete\ ${(j. .)${(q)args[1,-1-$#]}} "$@"
	fi
}
conda () {
	\local cmd="${1-__missing__}"
	case "$cmd" in
		(activate | deactivate) __conda_activate "$@" ;;
		(install | update | upgrade | remove | uninstall) __conda_exe "$@" || \return
			__conda_activate reactivate ;;
		(*) __conda_exe "$@" ;;
	esac
}
conda_prompt_info () {
	return 1
}
d () {
	if [[ -n $1 ]]
	then
		dirs "$@"
	else
		dirs -v | head -n 10
	fi
}
default () {
	(( $+parameters[$1] )) && return 0
	typeset -g "$1"="$2" && return 3
}
detect-clipboard () {
	emulate -L zsh
	if [[ "${OSTYPE}" == darwin* ]] && (( ${+commands[pbcopy]} )) && (( ${+commands[pbpaste]} ))
	then
		clipcopy () {
			cat "${1:-/dev/stdin}" | pbcopy
		}
		clippaste () {
			pbpaste
		}
	elif [[ "${OSTYPE}" == (cygwin|msys)* ]]
	then
		clipcopy () {
			cat "${1:-/dev/stdin}" > /dev/clipboard
		}
		clippaste () {
			cat /dev/clipboard
		}
	elif (( $+commands[clip.exe] )) && (( $+commands[powershell.exe] ))
	then
		clipcopy () {
			cat "${1:-/dev/stdin}" | clip.exe
		}
		clippaste () {
			powershell.exe -noprofile -command Get-Clipboard
		}
	elif [ -n "${WAYLAND_DISPLAY:-}" ] && (( ${+commands[wl-copy]} )) && (( ${+commands[wl-paste]} ))
	then
		clipcopy () {
			cat "${1:-/dev/stdin}" | wl-copy &> /dev/null &|
		}
		clippaste () {
			wl-paste --no-newline
		}
	elif [ -n "${DISPLAY:-}" ] && (( ${+commands[xsel]} ))
	then
		clipcopy () {
			cat "${1:-/dev/stdin}" | xsel --clipboard --input
		}
		clippaste () {
			xsel --clipboard --output
		}
	elif [ -n "${DISPLAY:-}" ] && (( ${+commands[xclip]} ))
	then
		clipcopy () {
			cat "${1:-/dev/stdin}" | xclip -selection clipboard -in &> /dev/null &|
		}
		clippaste () {
			xclip -out -selection clipboard
		}
	elif (( ${+commands[lemonade]} ))
	then
		clipcopy () {
			cat "${1:-/dev/stdin}" | lemonade copy
		}
		clippaste () {
			lemonade paste
		}
	elif (( ${+commands[doitclient]} ))
	then
		clipcopy () {
			cat "${1:-/dev/stdin}" | doitclient wclip
		}
		clippaste () {
			doitclient wclip -r
		}
	elif (( ${+commands[win32yank]} ))
	then
		clipcopy () {
			cat "${1:-/dev/stdin}" | win32yank -i
		}
		clippaste () {
			win32yank -o
		}
	elif [[ $OSTYPE == linux-android* ]] && (( $+commands[termux-clipboard-set] ))
	then
		clipcopy () {
			cat "${1:-/dev/stdin}" | termux-clipboard-set
		}
		clippaste () {
			termux-clipboard-get
		}
	elif [ -n "${TMUX:-}" ] && (( ${+commands[tmux]} ))
	then
		clipcopy () {
			tmux load-buffer -w "${1:--}"
		}
		clippaste () {
			tmux save-buffer -
		}
	else
		_retry_clipboard_detection_or_fail () {
			local clipcmd="${1}" 
			shift
			if detect-clipboard
			then
				"${clipcmd}" "$@"
			else
				print "${clipcmd}: Platform $OSTYPE not supported or xclip/xsel not installed" >&2
				return 1
			fi
		}
		clipcopy () {
			_retry_clipboard_detection_or_fail clipcopy "$@"
		}
		clippaste () {
			_retry_clipboard_detection_or_fail clippaste "$@"
		}
		return 1
	fi
}
diff () {
	command diff --color "$@"
}
down-line-or-beginning-search () {
	# undefined
	builtin autoload -XU
}
edit-command-line () {
	# undefined
	builtin autoload -XU
}
env_default () {
	[[ ${parameters[$1]} = *-export* ]] && return 0
	export "$1=$2" && return 3
}
gbda () {
	git branch --no-color --merged | command grep -vE "^([+*]|\s*($(git_main_branch)|$(git_develop_branch))\s*$)" | command xargs git branch --delete 2> /dev/null
}
gbds () {
	local default_branch=$(git_main_branch) 
	(( ! $? )) || default_branch=$(git_develop_branch) 
	git for-each-ref refs/heads/ "--format=%(refname:short)" | while read branch
	do
		local merge_base=$(git merge-base $default_branch $branch) 
		if [[ $(git cherry $default_branch $(git commit-tree $(git rev-parse $branch\^{tree}) -p $merge_base -m _)) = -* ]]
		then
			git branch -D $branch
		fi
	done
}
gccd () {
	setopt localoptions extendedglob
	local repo="${${@[(r)(ssh://*|git://*|ftp(s)#://*|http(s)#://*|*@*)(.git/#)#]}:-$_}" 
	command git clone --recurse-submodules "$@" || return
	[[ -d "$_" ]] && cd "$_" || cd "${${repo:t}%.git/#}"
}
gdnolock () {
	git diff "$@" ":(exclude)package-lock.json" ":(exclude)*.lock"
}
gdv () {
	git diff -w "$@" | view -
}
getent () {
	if [[ $1 = hosts ]]
	then
		sed 's/#.*//' /etc/$1 | grep -w $2
	elif [[ $2 = <-> ]]
	then
		grep ":$2:[^:]*$" /etc/$1
	else
		grep "^$2:" /etc/$1
	fi
}
ggf () {
	local b
	[[ $# != 1 ]] && b="$(git_current_branch)" 
	git push --force origin "${b:-$1}"
}
ggfl () {
	local b
	[[ $# != 1 ]] && b="$(git_current_branch)" 
	git push --force-with-lease origin "${b:-$1}"
}
ggl () {
	if [[ $# != 0 ]] && [[ $# != 1 ]]
	then
		git pull origin "${*}"
	else
		local b
		[[ $# == 0 ]] && b="$(git_current_branch)" 
		git pull origin "${b:-$1}"
	fi
}
ggp () {
	if [[ $# != 0 ]] && [[ $# != 1 ]]
	then
		git push origin "${*}"
	else
		local b
		[[ $# == 0 ]] && b="$(git_current_branch)" 
		git push origin "${b:-$1}"
	fi
}
ggpnp () {
	if [[ $# == 0 ]]
	then
		ggl && ggp
	else
		ggl "${*}" && ggp "${*}"
	fi
}
ggu () {
	local b
	[[ $# != 1 ]] && b="$(git_current_branch)" 
	git pull --rebase origin "${b:-$1}"
}
git_commits_ahead () {
	if __git_prompt_git rev-parse --git-dir &> /dev/null
	then
		local commits="$(__git_prompt_git rev-list --count @{upstream}..HEAD 2>/dev/null)" 
		if [[ -n "$commits" && "$commits" != 0 ]]
		then
			echo "$ZSH_THEME_GIT_COMMITS_AHEAD_PREFIX$commits$ZSH_THEME_GIT_COMMITS_AHEAD_SUFFIX"
		fi
	fi
}
git_commits_behind () {
	if __git_prompt_git rev-parse --git-dir &> /dev/null
	then
		local commits="$(__git_prompt_git rev-list --count HEAD..@{upstream} 2>/dev/null)" 
		if [[ -n "$commits" && "$commits" != 0 ]]
		then
			echo "$ZSH_THEME_GIT_COMMITS_BEHIND_PREFIX$commits$ZSH_THEME_GIT_COMMITS_BEHIND_SUFFIX"
		fi
	fi
}
git_current_branch () {
	local ref
	ref=$(__git_prompt_git symbolic-ref --quiet HEAD 2> /dev/null) 
	local ret=$? 
	if [[ $ret != 0 ]]
	then
		[[ $ret == 128 ]] && return
		ref=$(__git_prompt_git rev-parse --short HEAD 2> /dev/null)  || return
	fi
	echo ${ref#refs/heads/}
}
git_current_user_email () {
	__git_prompt_git config user.email 2> /dev/null
}
git_current_user_name () {
	__git_prompt_git config user.name 2> /dev/null
}
git_develop_branch () {
	command git rev-parse --git-dir &> /dev/null || return
	local branch
	for branch in dev devel develop development
	do
		if command git show-ref -q --verify refs/heads/$branch
		then
			echo $branch
			return 0
		fi
	done
	echo develop
	return 1
}
git_main_branch () {
	command git rev-parse --git-dir &> /dev/null || return
	local remote ref
	for ref in refs/{heads,remotes/{origin,upstream}}/{main,trunk,mainline,default,stable,master}
	do
		if command git show-ref -q --verify $ref
		then
			echo ${ref:t}
			return 0
		fi
	done
	for remote in origin upstream
	do
		ref=$(command git rev-parse --abbrev-ref $remote/HEAD 2>/dev/null) 
		if [[ $ref == $remote/* ]]
		then
			echo ${ref#"$remote/"}
			return 0
		fi
	done
	echo master
	return 1
}
git_previous_branch () {
	local ref
	ref=$(__git_prompt_git rev-parse --quiet --symbolic-full-name @{-1} 2> /dev/null) 
	local ret=$? 
	if [[ $ret != 0 ]] || [[ -z $ref ]]
	then
		return
	fi
	echo ${ref#refs/heads/}
}
git_prompt_ahead () {
	if [[ -n "$(__git_prompt_git rev-list origin/$(git_current_branch)..HEAD 2> /dev/null)" ]]
	then
		echo "$ZSH_THEME_GIT_PROMPT_AHEAD"
	fi
}
git_prompt_behind () {
	if [[ -n "$(__git_prompt_git rev-list HEAD..origin/$(git_current_branch) 2> /dev/null)" ]]
	then
		echo "$ZSH_THEME_GIT_PROMPT_BEHIND"
	fi
}
git_prompt_info () {
	if [[ -n "${_OMZ_ASYNC_OUTPUT[_omz_git_prompt_info]}" ]]
	then
		echo -n "${_OMZ_ASYNC_OUTPUT[_omz_git_prompt_info]}"
	fi
}
git_prompt_long_sha () {
	local SHA
	SHA=$(__git_prompt_git rev-parse HEAD 2> /dev/null)  && echo "$ZSH_THEME_GIT_PROMPT_SHA_BEFORE$SHA$ZSH_THEME_GIT_PROMPT_SHA_AFTER"
}
git_prompt_remote () {
	if [[ -n "$(__git_prompt_git show-ref origin/$(git_current_branch) 2> /dev/null)" ]]
	then
		echo "$ZSH_THEME_GIT_PROMPT_REMOTE_EXISTS"
	else
		echo "$ZSH_THEME_GIT_PROMPT_REMOTE_MISSING"
	fi
}
git_prompt_short_sha () {
	local SHA
	SHA=$(__git_prompt_git rev-parse --short HEAD 2> /dev/null)  && echo "$ZSH_THEME_GIT_PROMPT_SHA_BEFORE$SHA$ZSH_THEME_GIT_PROMPT_SHA_AFTER"
}
git_prompt_status () {
	if [[ -n "${_OMZ_ASYNC_OUTPUT[_omz_git_prompt_status]}" ]]
	then
		echo -n "${_OMZ_ASYNC_OUTPUT[_omz_git_prompt_status]}"
	fi
}
git_remote_status () {
	local remote ahead behind git_remote_status git_remote_status_detailed
	remote=${$(__git_prompt_git rev-parse --verify ${hook_com[branch]}@{upstream} --symbolic-full-name 2>/dev/null)/refs\/remotes\/} 
	if [[ -n ${remote} ]]
	then
		ahead=$(__git_prompt_git rev-list ${hook_com[branch]}@{upstream}..HEAD 2>/dev/null | wc -l) 
		behind=$(__git_prompt_git rev-list HEAD..${hook_com[branch]}@{upstream} 2>/dev/null | wc -l) 
		if [[ $ahead -eq 0 ]] && [[ $behind -eq 0 ]]
		then
			git_remote_status="$ZSH_THEME_GIT_PROMPT_EQUAL_REMOTE" 
		elif [[ $ahead -gt 0 ]] && [[ $behind -eq 0 ]]
		then
			git_remote_status="$ZSH_THEME_GIT_PROMPT_AHEAD_REMOTE" 
			git_remote_status_detailed="$ZSH_THEME_GIT_PROMPT_AHEAD_REMOTE_COLOR$ZSH_THEME_GIT_PROMPT_AHEAD_REMOTE$((ahead))%{$reset_color%}" 
		elif [[ $behind -gt 0 ]] && [[ $ahead -eq 0 ]]
		then
			git_remote_status="$ZSH_THEME_GIT_PROMPT_BEHIND_REMOTE" 
			git_remote_status_detailed="$ZSH_THEME_GIT_PROMPT_BEHIND_REMOTE_COLOR$ZSH_THEME_GIT_PROMPT_BEHIND_REMOTE$((behind))%{$reset_color%}" 
		elif [[ $ahead -gt 0 ]] && [[ $behind -gt 0 ]]
		then
			git_remote_status="$ZSH_THEME_GIT_PROMPT_DIVERGED_REMOTE" 
			git_remote_status_detailed="$ZSH_THEME_GIT_PROMPT_AHEAD_REMOTE_COLOR$ZSH_THEME_GIT_PROMPT_AHEAD_REMOTE$((ahead))%{$reset_color%}$ZSH_THEME_GIT_PROMPT_BEHIND_REMOTE_COLOR$ZSH_THEME_GIT_PROMPT_BEHIND_REMOTE$((behind))%{$reset_color%}" 
		fi
		if [[ -n $ZSH_THEME_GIT_PROMPT_REMOTE_STATUS_DETAILED ]]
		then
			git_remote_status="$ZSH_THEME_GIT_PROMPT_REMOTE_STATUS_PREFIX${remote//\%/%%}$git_remote_status_detailed$ZSH_THEME_GIT_PROMPT_REMOTE_STATUS_SUFFIX" 
		fi
		echo $git_remote_status
	fi
}
git_repo_name () {
	local repo_path
	if repo_path="$(__git_prompt_git rev-parse --show-toplevel 2>/dev/null)"  && [[ -n "$repo_path" ]]
	then
		echo ${repo_path:t}
	fi
}
grename () {
	if [[ -z "$1" || -z "$2" ]]
	then
		echo "Usage: $0 old_branch new_branch"
		return 1
	fi
	git branch -m "$1" "$2"
	if git push origin :"$1"
	then
		git push --set-upstream origin "$2"
	fi
}
gunwipall () {
	local _commit=$(git log --grep='--wip--' --invert-grep --max-count=1 --format=format:%H) 
	if [[ "$_commit" != "$(git rev-parse HEAD)" ]]
	then
		git reset $_commit || return 1
	fi
}
handle_completion_insecurities () {
	local -aU insecure_dirs
	insecure_dirs=(${(f@):-"$(compaudit 2>/dev/null)"}) 
	[[ -z "${insecure_dirs}" ]] && return
	print "[oh-my-zsh] Insecure completion-dependent directories detected:"
	ls -ld "${(@)insecure_dirs}"
	cat <<EOD

[oh-my-zsh] For safety, we will not load completions from these directories until
[oh-my-zsh] you fix their permissions and ownership and restart zsh.
[oh-my-zsh] See the above list for directories with group or other writability.

[oh-my-zsh] To fix your permissions you can do so by disabling
[oh-my-zsh] the write permission of "group" and "others" and making sure that the
[oh-my-zsh] owner of these directories is either root or your current user.
[oh-my-zsh] The following command may help:
[oh-my-zsh]     compaudit | xargs chmod g-w,o-w

[oh-my-zsh] If the above didn't help or you want to skip the verification of
[oh-my-zsh] insecure directories you can set the variable ZSH_DISABLE_COMPFIX to
[oh-my-zsh] "true" before oh-my-zsh is sourced in your zshrc file.

EOD
}
hg_prompt_info () {
	return 1
}
is-at-least () {
	emulate -L zsh
	local IFS=".-" min_cnt=0 ver_cnt=0 part min_ver version order 
	min_ver=(${=1}) 
	version=(${=2:-$ZSH_VERSION} 0) 
	while (( $min_cnt <= ${#min_ver} ))
	do
		while [[ "$part" != <-> ]]
		do
			(( ++ver_cnt > ${#version} )) && return 0
			if [[ ${version[ver_cnt]} = *[0-9][^0-9]* ]]
			then
				order=(${version[ver_cnt]} ${min_ver[ver_cnt]}) 
				if [[ ${version[ver_cnt]} = <->* ]]
				then
					[[ $order != ${${(On)order}} ]] && return 1
				else
					[[ $order != ${${(O)order}} ]] && return 1
				fi
				[[ $order[1] != $order[2] ]] && return 0
			fi
			part=${version[ver_cnt]##*[^0-9]} 
		done
		while true
		do
			(( ++min_cnt > ${#min_ver} )) && return 0
			[[ ${min_ver[min_cnt]} = <-> ]] && break
		done
		(( part > min_ver[min_cnt] )) && return 0
		(( part < min_ver[min_cnt] )) && return 1
		part='' 
	done
}
is_plugin () {
	local base_dir=$1 
	local name=$2 
	builtin test -f $base_dir/plugins/$name/$name.plugin.zsh || builtin test -f $base_dir/plugins/$name/_$name
}
is_theme () {
	local base_dir=$1 
	local name=$2 
	builtin test -f $base_dir/$name.zsh-theme
}
jenv_prompt_info () {
	return 1
}
mkcd () {
	mkdir -p $@ && cd ${@:$#}
}
nvm_prompt_info () {
	which nvm &> /dev/null || return
	local nvm_prompt=${$(nvm current)#v} 
	echo "${ZSH_THEME_NVM_PROMPT_PREFIX}${nvm_prompt:gs/%/%%}${ZSH_THEME_NVM_PROMPT_SUFFIX}"
}
omz () {
	setopt localoptions noksharrays
	[[ $# -gt 0 ]] || {
		_omz::help
		return 1
	}
	local command="$1" 
	shift
	(( ${+functions[_omz::$command]} )) || {
		_omz::help
		return 1
	}
	_omz::$command "$@"
}
omz_diagnostic_dump () {
	emulate -L zsh
	builtin echo "Generating diagnostic dump; please be patient..."
	local thisfcn=omz_diagnostic_dump 
	local -A opts
	local opt_verbose opt_noverbose opt_outfile
	local timestamp=$(date +%Y%m%d-%H%M%S) 
	local outfile=omz_diagdump_$timestamp.txt 
	builtin zparseopts -A opts -D -- "v+=opt_verbose" "V+=opt_noverbose"
	local verbose n_verbose=${#opt_verbose} n_noverbose=${#opt_noverbose} 
	(( verbose = 1 + n_verbose - n_noverbose ))
	if [[ ${#*} > 0 ]]
	then
		opt_outfile=$1 
	fi
	if [[ ${#*} > 1 ]]
	then
		builtin echo "$thisfcn: error: too many arguments" >&2
		return 1
	fi
	if [[ -n "$opt_outfile" ]]
	then
		outfile="$opt_outfile" 
	fi
	_omz_diag_dump_one_big_text &> "$outfile"
	if [[ $? != 0 ]]
	then
		builtin echo "$thisfcn: error while creating diagnostic dump; see $outfile for details"
	fi
	builtin echo
	builtin echo Diagnostic dump file created at: "$outfile"
	builtin echo
	builtin echo To share this with OMZ developers, post it as a gist on GitHub
	builtin echo at "https://gist.github.com" and share the link to the gist.
	builtin echo
	builtin echo "WARNING: This dump file contains all your zsh and omz configuration files,"
	builtin echo "so don't share it publicly if there's sensitive information in them."
	builtin echo
}
omz_history () {
	local clear list stamp REPLY
	zparseopts -E -D c=clear l=list f=stamp E=stamp i=stamp t:=stamp
	if [[ -n "$clear" ]]
	then
		print -nu2 "This action will irreversibly delete your command history. Are you sure? [y/N] "
		builtin read -E
		[[ "$REPLY" = [yY] ]] || return 0
		print -nu2 >| "$HISTFILE"
		fc -p "$HISTFILE"
		print -u2 History file deleted.
	elif [[ $# -eq 0 ]]
	then
		builtin fc "${stamp[@]}" -l 1
	else
		builtin fc "${stamp[@]}" -l "$@"
	fi
}
omz_termsupport_precmd () {
	[[ "${DISABLE_AUTO_TITLE:-}" != true ]] || return 0
	title "$ZSH_THEME_TERM_TAB_TITLE_IDLE" "$ZSH_THEME_TERM_TITLE_IDLE"
}
omz_termsupport_preexec () {
	[[ "${DISABLE_AUTO_TITLE:-}" != true ]] || return 0
	emulate -L zsh
	setopt extended_glob
	local -a cmdargs
	cmdargs=("${(z)2}") 
	if [[ "${cmdargs[1]}" = fg ]]
	then
		local job_id jobspec="${cmdargs[2]#%}" 
		case "$jobspec" in
			(<->) job_id=${jobspec}  ;;
			("" | % | +) job_id=${(k)jobstates[(r)*:+:*]}  ;;
			(-) job_id=${(k)jobstates[(r)*:-:*]}  ;;
			([?]*) job_id=${(k)jobtexts[(r)*${(Q)jobspec}*]}  ;;
			(*) job_id=${(k)jobtexts[(r)${(Q)jobspec}*]}  ;;
		esac
		if [[ -n "${jobtexts[$job_id]}" ]]
		then
			1="${jobtexts[$job_id]}" 
			2="${jobtexts[$job_id]}" 
		fi
	fi
	local CMD="${1[(wr)^(*=*|sudo|ssh|mosh|rake|-*)]:gs/%/%%}" 
	local LINE="${2:gs/%/%%}" 
	title "$CMD" "%100>...>${LINE}%<<"
}
omz_urldecode () {
	emulate -L zsh
	local encoded_url=$1 
	local caller_encoding=$langinfo[CODESET] 
	local LC_ALL=C 
	export LC_ALL
	local tmp=${encoded_url:gs/+/ /} 
	tmp=${tmp:gs/\\/\\\\/} 
	tmp=${tmp:gs/%/\\x/} 
	local decoded="$(printf -- "$tmp")" 
	local -a safe_encodings
	safe_encodings=(UTF-8 utf8 US-ASCII) 
	if [[ -z ${safe_encodings[(r)$caller_encoding]} ]]
	then
		decoded=$(echo -E "$decoded" | iconv -f UTF-8 -t $caller_encoding) 
		if [[ $? != 0 ]]
		then
			echo "Error converting string from UTF-8 to $caller_encoding" >&2
			return 1
		fi
	fi
	echo -E "$decoded"
}
omz_urlencode () {
	emulate -L zsh
	setopt norematchpcre
	local -a opts
	zparseopts -D -E -a opts r m P
	local in_str="$@" 
	local url_str="" 
	local spaces_as_plus
	if [[ -z $opts[(r)-P] ]]
	then
		spaces_as_plus=1 
	fi
	local str="$in_str" 
	local encoding=$langinfo[CODESET] 
	local safe_encodings
	safe_encodings=(UTF-8 utf8 US-ASCII) 
	if [[ -z ${safe_encodings[(r)$encoding]} ]]
	then
		str=$(echo -E "$str" | iconv -f $encoding -t UTF-8) 
		if [[ $? != 0 ]]
		then
			echo "Error converting string from $encoding to UTF-8" >&2
			return 1
		fi
	fi
	local i byte ord LC_ALL=C 
	export LC_ALL
	local reserved=';/?:@&=+$,' 
	local mark='_.!~*''()-' 
	local dont_escape="[A-Za-z0-9" 
	if [[ -z $opts[(r)-r] ]]
	then
		dont_escape+=$reserved 
	fi
	if [[ -z $opts[(r)-m] ]]
	then
		dont_escape+=$mark 
	fi
	dont_escape+="]" 
	local url_str="" 
	for ((i = 1; i <= ${#str}; ++i )) do
		byte="$str[i]" 
		if [[ "$byte" =~ "$dont_escape" ]]
		then
			url_str+="$byte" 
		else
			if [[ "$byte" == " " && -n $spaces_as_plus ]]
			then
				url_str+="+" 
			elif [[ "$PREFIX" = *com.termux* ]]
			then
				url_str+="$byte" 
			else
				ord=$(( [##16] #byte )) 
				url_str+="%$ord" 
			fi
		fi
	done
	echo -E "$url_str"
}
open_command () {
	local open_cmd
	case "$OSTYPE" in
		(darwin*) open_cmd='open'  ;;
		(cygwin*) open_cmd='cygstart'  ;;
		(linux*) [[ "$(uname -r)" != *icrosoft* ]] && open_cmd='nohup xdg-open'  || {
				open_cmd='cmd.exe /c start ""' 
				[[ -e "$1" ]] && {
					1="$(wslpath -w "${1:a}")"  || return 1
				}
				[[ "$1" = (http|https)://* ]] && {
					1="$(echo "$1" | sed -E 's/([&|()<>^])/^\1/g')"  || return 1
				}
			} ;;
		(msys*) open_cmd='start ""'  ;;
		(*) echo "Platform $OSTYPE not supported"
			return 1 ;;
	esac
	if [[ -n "$BROWSER" && "$1" = (http|https)://* ]]
	then
		"$BROWSER" "$@"
		return
	fi
	${=open_cmd} "$@" &> /dev/null
}
parse_git_dirty () {
	local STATUS
	local -a FLAGS
	FLAGS=('--porcelain') 
	if [[ "$(__git_prompt_git config --get oh-my-zsh.hide-dirty)" != "1" ]]
	then
		if [[ "${DISABLE_UNTRACKED_FILES_DIRTY:-}" == "true" ]]
		then
			FLAGS+='--untracked-files=no' 
		fi
		case "${GIT_STATUS_IGNORE_SUBMODULES:-}" in
			(git)  ;;
			(*) FLAGS+="--ignore-submodules=${GIT_STATUS_IGNORE_SUBMODULES:-dirty}"  ;;
		esac
		STATUS=$(__git_prompt_git status ${FLAGS} 2> /dev/null | tail -n 1) 
	fi
	if [[ -n $STATUS ]]
	then
		echo "$ZSH_THEME_GIT_PROMPT_DIRTY"
	else
		echo "$ZSH_THEME_GIT_PROMPT_CLEAN"
	fi
}
pyenv () {
	local command=${1:-} 
	[ "$#" -gt 0 ] && shift
	case "$command" in
		(activate | deactivate | rehash | shell) eval "$(pyenv "sh-$command" "$@")" ;;
		(*) command pyenv "$command" "$@" ;;
	esac
}
pyenv_prompt_info () {
	return 1
}
rbenv_prompt_info () {
	return 1
}
regexp-replace () {
	argv=("$1" "$2" "$3") 
	4=0 
	[[ -o re_match_pcre ]] && 4=1 
	emulate -L zsh
	local MATCH MBEGIN MEND
	local -a match mbegin mend
	if (( $4 ))
	then
		zmodload zsh/pcre || return 2
		pcre_compile -- "$2" && pcre_study || return 2
		4=0 6= 
		local ZPCRE_OP
		while pcre_match -b -n $4 -- "${(P)1}"
		do
			5=${(e)3} 
			argv+=(${(s: :)ZPCRE_OP} "$5") 
			4=$((argv[-2] + (argv[-3] == argv[-2]))) 
		done
		(($# > 6)) || return
		set +o multibyte
		5= 6=1 
		for 2 3 4 in "$@[7,-1]"
		do
			5+=${(P)1[$6,$2]}$4 
			6=$(($3 + 1)) 
		done
		5+=${(P)1[$6,-1]} 
	else
		4=${(P)1} 
		while [[ -n $4 ]]
		do
			if [[ $4 =~ $2 ]]
			then
				5+=${4[1,MBEGIN-1]}${(e)3} 
				if ((MEND < MBEGIN))
				then
					((MEND++))
					5+=${4[1]} 
				fi
				4=${4[MEND+1,-1]} 
				6=1 
			else
				break
			fi
		done
		[[ -n $6 ]] || return
		5+=$4 
	fi
	eval $1=\$5
}
ruby_prompt_info () {
	echo "$(rvm_prompt_info || rbenv_prompt_info || chruby_prompt_info)"
}
rvm_prompt_info () {
	[ -f $HOME/.rvm/bin/rvm-prompt ] || return 1
	local rvm_prompt
	rvm_prompt=$($HOME/.rvm/bin/rvm-prompt ${=ZSH_THEME_RVM_PROMPT_OPTIONS} 2>/dev/null) 
	[[ -z "${rvm_prompt}" ]] && return 1
	echo "${ZSH_THEME_RUBY_PROMPT_PREFIX}${rvm_prompt:gs/%/%%}${ZSH_THEME_RUBY_PROMPT_SUFFIX}"
}
spectrum_bls () {
	setopt localoptions nopromptsubst
	local ZSH_SPECTRUM_TEXT=${ZSH_SPECTRUM_TEXT:-Arma virumque cano Troiae qui primus ab oris} 
	for code in {000..255}
	do
		print -P -- "$code: ${BG[$code]}${ZSH_SPECTRUM_TEXT}%{$reset_color%}"
	done
}
spectrum_ls () {
	setopt localoptions nopromptsubst
	local ZSH_SPECTRUM_TEXT=${ZSH_SPECTRUM_TEXT:-Arma virumque cano Troiae qui primus ab oris} 
	for code in {000..255}
	do
		print -P -- "$code: ${FG[$code]}${ZSH_SPECTRUM_TEXT}%{$reset_color%}"
	done
}
svn_prompt_info () {
	return 1
}
take () {
	if [[ $1 =~ ^(https?|ftp).*\.(tar\.(gz|bz2|xz)|tgz)$ ]]
	then
		takeurl "$1"
	elif [[ $1 =~ ^(https?|ftp).*\.(zip)$ ]]
	then
		takezip "$1"
	elif [[ $1 =~ ^([A-Za-z0-9]\+@|https?|git|ssh|ftps?|rsync).*\.git/?$ ]]
	then
		takegit "$1"
	else
		takedir "$@"
	fi
}
takedir () {
	mkdir -p $@ && cd ${@:$#}
}
takegit () {
	git clone "$1"
	cd "$(basename ${1%%.git})"
}
takeurl () {
	local data thedir
	data="$(mktemp)" 
	curl -L "$1" > "$data"
	tar xf "$data"
	thedir="$(tar tf "$data" | head -n 1)" 
	rm "$data"
	cd "$thedir"
}
takezip () {
	local data thedir
	data="$(mktemp)" 
	curl -L "$1" > "$data"
	unzip "$data" -d "./"
	thedir="$(unzip -l "$data" | awk 'NR==4 {print $4}' | sed 's/\/.*//')" 
	rm "$data"
	cd "$thedir"
}
tf_prompt_info () {
	return 1
}
title () {
	setopt localoptions nopromptsubst
	[[ -n "${INSIDE_EMACS:-}" && "$INSIDE_EMACS" != vterm ]] && return
	: ${2=$1}
	case "$TERM" in
		(cygwin | xterm* | putty* | rxvt* | konsole* | ansi | mlterm* | alacritty* | st* | foot* | contour* | wezterm*) print -Pn "\e]2;${2:q}\a"
			print -Pn "\e]1;${1:q}\a" ;;
		(screen* | tmux*) print -Pn "\ek${1:q}\e\\" ;;
		(*) if [[ "$TERM_PROGRAM" == "iTerm.app" ]]
			then
				print -Pn "\e]2;${2:q}\a"
				print -Pn "\e]1;${1:q}\a"
			else
				if (( ${+terminfo[fsl]} && ${+terminfo[tsl]} ))
				then
					print -Pn "${terminfo[tsl]}$1${terminfo[fsl]}"
				fi
			fi ;;
	esac
}
try_alias_value () {
	alias_value "$1" || echo "$1"
}
uninstall_oh_my_zsh () {
	command env ZSH="$ZSH" sh "$ZSH/tools/uninstall.sh"
}
up-line-or-beginning-search () {
	# undefined
	builtin autoload -XU
}
upgrade_oh_my_zsh () {
	echo "${fg[yellow]}Note: \`$0\` is deprecated. Use \`omz update\` instead.$reset_color" >&2
	omz update
}
url-quote-magic () {
	# undefined
	builtin autoload -XUz
}
vi_mode_prompt_info () {
	return 1
}
virtualenv_prompt_info () {
	return 1
}
work_in_progress () {
	command git -c log.showSignature=false log -n 1 2> /dev/null | grep --color=auto --exclude-dir={.bzr,CVS,.git,.hg,.svn,.idea,.tox,.venv,venv} -q -- "--wip--" && echo "WIP!!"
}
zrecompile () {
	# undefined
	builtin autoload -XU
}
zsh_stats () {
	fc -l 1 | awk '{ CMD[$2]++; count++; } END { for (a in CMD) print CMD[a] " " CMD[a]*100/count "% " a }' | grep -v "./" | sort -nr | head -n 20 | column -c3 -s " " -t | nl
}

# setopts 18
setopt alwaystoend
setopt autocd
setopt autopushd
setopt completeinword
setopt extendedhistory
setopt noflowcontrol
setopt nohashdirs
setopt histexpiredupsfirst
setopt histignoredups
setopt histignorespace
setopt histverify
setopt interactivecomments
setopt login
setopt longlistjobs
setopt promptsubst
setopt pushdignoredups
setopt pushdminus
setopt sharehistory

# aliases 230
alias -- -='cd -'
alias -g ...=../..
alias -g ....=../../..
alias -g .....=../../../..
alias -g ......=../../../../..
alias 1='cd -1'
alias 2='cd -2'
alias 3='cd -3'
alias 4='cd -4'
alias 5='cd -5'
alias 6='cd -6'
alias 7='cd -7'
alias 8='cd -8'
alias 9='cd -9'
alias _='sudo '
alias current_branch=$'\n    print -Pu2 "%F{yellow}[oh-my-zsh] \'%F{red}current_branch%F{yellow}\' is deprecated, using \'%F{green}git_current_branch%F{yellow}\' instead.%f"\n    git_current_branch'
alias egrep='grep -E'
alias fgrep='grep -F'
alias g=git
alias ga='git add'
alias gaa='git add --all'
alias gam='git am'
alias gama='git am --abort'
alias gamc='git am --continue'
alias gams='git am --skip'
alias gamscp='git am --show-current-patch'
alias gap='git apply'
alias gapa='git add --patch'
alias gapt='git apply --3way'
alias gau='git add --update'
alias gav='git add --verbose'
alias gb='git branch'
alias gbD='git branch --delete --force'
alias gba='git branch --all'
alias gbd='git branch --delete'
alias gbg='LANG=C git branch -vv | grep ": gone\]"'
alias gbgD='LANG=C git branch --no-color -vv | grep ": gone\]" | cut -c 3- | awk '\''{print $1}'\'' | xargs git branch -D'
alias gbgd='LANG=C git branch --no-color -vv | grep ": gone\]" | cut -c 3- | awk '\''{print $1}'\'' | xargs git branch -d'
alias gbl='git blame -w'
alias gbm='git branch --move'
alias gbnm='git branch --no-merged'
alias gbr='git branch --remote'
alias gbs='git bisect'
alias gbsb='git bisect bad'
alias gbsg='git bisect good'
alias gbsn='git bisect new'
alias gbso='git bisect old'
alias gbsr='git bisect reset'
alias gbss='git bisect start'
alias gc='git commit --verbose'
alias gc!='git commit --verbose --amend'
alias gcB='git checkout -B'
alias gca='git commit --verbose --all'
alias gca!='git commit --verbose --all --amend'
alias gcam='git commit --all --message'
alias gcan!='git commit --verbose --all --no-edit --amend'
alias gcann!='git commit --verbose --all --date=now --no-edit --amend'
alias gcans!='git commit --verbose --all --signoff --no-edit --amend'
alias gcas='git commit --all --signoff'
alias gcasm='git commit --all --signoff --message'
alias gcb='git checkout -b'
alias gcd='git checkout $(git_develop_branch)'
alias gcf='git config --list'
alias gcfu='git commit --fixup'
alias gcl='git clone --recurse-submodules'
alias gclean='git clean --interactive -d'
alias gclf='git clone --recursive --shallow-submodules --filter=blob:none --also-filter-submodules'
alias gcm='git checkout $(git_main_branch)'
alias gcmsg='git commit --message'
alias gcn='git commit --verbose --no-edit'
alias gcn!='git commit --verbose --no-edit --amend'
alias gco='git checkout'
alias gcor='git checkout --recurse-submodules'
alias gcount='git shortlog --summary --numbered'
alias gcp='git cherry-pick'
alias gcpa='git cherry-pick --abort'
alias gcpc='git cherry-pick --continue'
alias gcs='git commit --gpg-sign'
alias gcsm='git commit --signoff --message'
alias gcss='git commit --gpg-sign --signoff'
alias gcssm='git commit --gpg-sign --signoff --message'
alias gd='git diff'
alias gdca='git diff --cached'
alias gdct='git describe --tags $(git rev-list --tags --max-count=1)'
alias gdcw='git diff --cached --word-diff'
alias gds='git diff --staged'
alias gdt='git diff-tree --no-commit-id --name-only -r'
alias gdup='git diff @{upstream}'
alias gdw='git diff --word-diff'
alias gf='git fetch'
alias gfa='git fetch --all --tags --prune --jobs=10'
alias gfg='git ls-files | grep'
alias gfo='git fetch origin'
alias gg='git gui citool'
alias gga='git gui citool --amend'
alias ggpull='git pull origin "$(git_current_branch)"'
alias ggpur=ggu
alias ggpush='git push origin "$(git_current_branch)"'
alias ggsup='git branch --set-upstream-to=origin/$(git_current_branch)'
alias ghh='git help'
alias gignore='git update-index --assume-unchanged'
alias gignored='git ls-files -v | grep "^[[:lower:]]"'
alias git-svn-dcommit-push='git svn dcommit && git push github $(git_main_branch):svntrunk'
alias gk='\gitk --all --branches &!'
alias gke='\gitk --all $(git log --walk-reflogs --pretty=%h) &!'
alias gl='git pull'
alias glg='git log --stat'
alias glgg='git log --graph'
alias glgga='git log --graph --decorate --all'
alias glgm='git log --graph --max-count=10'
alias glgp='git log --stat --patch'
alias glo='git log --oneline --decorate'
alias glod='git log --graph --pretty="%Cred%h%Creset -%C(auto)%d%Creset %s %Cgreen(%ad) %C(bold blue)<%an>%Creset"'
alias glods='git log --graph --pretty="%Cred%h%Creset -%C(auto)%d%Creset %s %Cgreen(%ad) %C(bold blue)<%an>%Creset" --date=short'
alias glog='git log --oneline --decorate --graph'
alias gloga='git log --oneline --decorate --graph --all'
alias glol='git log --graph --pretty="%Cred%h%Creset -%C(auto)%d%Creset %s %Cgreen(%ar) %C(bold blue)<%an>%Creset"'
alias glola='git log --graph --pretty="%Cred%h%Creset -%C(auto)%d%Creset %s %Cgreen(%ar) %C(bold blue)<%an>%Creset" --all'
alias glols='git log --graph --pretty="%Cred%h%Creset -%C(auto)%d%Creset %s %Cgreen(%ar) %C(bold blue)<%an>%Creset" --stat'
alias glp=_git_log_prettily
alias gluc='git pull upstream $(git_current_branch)'
alias glum='git pull upstream $(git_main_branch)'
alias gm='git merge'
alias gma='git merge --abort'
alias gmc='git merge --continue'
alias gmff='git merge --ff-only'
alias gmom='git merge origin/$(git_main_branch)'
alias gms='git merge --squash'
alias gmtl='git mergetool --no-prompt'
alias gmtlvim='git mergetool --no-prompt --tool=vimdiff'
alias gmum='git merge upstream/$(git_main_branch)'
alias gp='git push'
alias gpd='git push --dry-run'
alias gpf='git push --force-with-lease --force-if-includes'
alias gpf!='git push --force'
alias gpoat='git push origin --all && git push origin --tags'
alias gpod='git push origin --delete'
alias gpr='git pull --rebase'
alias gpra='git pull --rebase --autostash'
alias gprav='git pull --rebase --autostash -v'
alias gpristine='git reset --hard && git clean --force -dfx'
alias gprom='git pull --rebase origin $(git_main_branch)'
alias gpromi='git pull --rebase=interactive origin $(git_main_branch)'
alias gprum='git pull --rebase upstream $(git_main_branch)'
alias gprumi='git pull --rebase=interactive upstream $(git_main_branch)'
alias gprv='git pull --rebase -v'
alias gpsup='git push --set-upstream origin $(git_current_branch)'
alias gpsupf='git push --set-upstream origin $(git_current_branch) --force-with-lease --force-if-includes'
alias gpu='git push upstream'
alias gpv='git push --verbose'
alias gr='git remote'
alias gra='git remote add'
alias grb='git rebase'
alias grba='git rebase --abort'
alias grbc='git rebase --continue'
alias grbd='git rebase $(git_develop_branch)'
alias grbi='git rebase --interactive'
alias grbm='git rebase $(git_main_branch)'
alias grbo='git rebase --onto'
alias grbom='git rebase origin/$(git_main_branch)'
alias grbs='git rebase --skip'
alias grbum='git rebase upstream/$(git_main_branch)'
alias grep='grep --color=auto --exclude-dir={.bzr,CVS,.git,.hg,.svn,.idea,.tox,.venv,venv}'
alias grev='git revert'
alias greva='git revert --abort'
alias grevc='git revert --continue'
alias grf='git reflog'
alias grh='git reset'
alias grhh='git reset --hard'
alias grhk='git reset --keep'
alias grhs='git reset --soft'
alias grm='git rm'
alias grmc='git rm --cached'
alias grmv='git remote rename'
alias groh='git reset origin/$(git_current_branch) --hard'
alias grrm='git remote remove'
alias grs='git restore'
alias grset='git remote set-url'
alias grss='git restore --source'
alias grst='git restore --staged'
alias grt='cd "$(git rev-parse --show-toplevel || echo .)"'
alias gru='git reset --'
alias grup='git remote update'
alias grv='git remote --verbose'
alias gsb='git status --short --branch'
alias gsd='git svn dcommit'
alias gsh='git show'
alias gsi='git submodule init'
alias gsps='git show --pretty=short --show-signature'
alias gsr='git svn rebase'
alias gss='git status --short'
alias gst='git status'
alias gsta='git stash push'
alias gstaa='git stash apply'
alias gstall='git stash --all'
alias gstc='git stash clear'
alias gstd='git stash drop'
alias gstl='git stash list'
alias gstp='git stash pop'
alias gsts='git stash show --patch'
alias gstu='gsta --include-untracked'
alias gsu='git submodule update'
alias gsw='git switch'
alias gswc='git switch --create'
alias gswd='git switch $(git_develop_branch)'
alias gswm='git switch $(git_main_branch)'
alias gta='git tag --annotate'
alias gtl='gtl(){ git tag --sort=-v:refname -n --list "${1}*" }; noglob gtl'
alias gts='git tag --sign'
alias gtv='git tag | sort -V'
alias gunignore='git update-index --no-assume-unchanged'
alias gunwip='git rev-list --max-count=1 --format="%s" HEAD | grep -q "\--wip--" && git reset HEAD~1'
alias gwch='git log --patch --abbrev-commit --pretty=medium --raw'
alias gwip='git add -A; git rm $(git ls-files --deleted) 2> /dev/null; git commit --no-verify --no-gpg-sign --message "--wip-- [skip ci]"'
alias gwipe='git reset --hard && git clean --force -df'
alias gwt='git worktree'
alias gwta='git worktree add'
alias gwtls='git worktree list'
alias gwtmv='git worktree move'
alias gwtrm='git worktree remove'
alias history=omz_history
alias l='ls -CF'
alias la='ls -A'
alias ll='ls -alF'
alias ls='ls -G'
alias lsa='ls -lah'
alias md='mkdir -p'
alias rd=rmdir
alias run-help=man
alias which-command=whence

# exports 112
export AICUICAN_API_KEY=sk-9UG4A9PVJhIh0koX0CCE0eTeSo74kTLD38h9bde13uYM0BXN
export ANTHROPIC_API_KEY=sk-sp-35527d4dc82d451ab8fb467a8165955a
export ANTHROPIC_AUTH_TOKEN=sk-sp-35527d4dc82d451ab8fb467a8165955a
export ANTHROPIC_BASE_URL=https://coding.dashscope.aliyuncs.com/apps/anthropic
export ANTHROPIC_MODEL=qwen3.5-plus
export CARGO=/Users/wangqichen/.rustup/toolchains/stable-aarch64-apple-darwin/bin/cargo
export CARGO_HOME=/Users/wangqichen/.cargo
export CARGO_MANIFEST_DIR=/Users/wangqichen/projects/brilliant/cuican-aide/codex-rs/app-server
export CARGO_MANIFEST_PATH=/Users/wangqichen/projects/brilliant/cuican-aide/codex-rs/app-server/Cargo.toml
export CARGO_PKG_AUTHORS=''
export CARGO_PKG_DESCRIPTION=''
export CARGO_PKG_HOMEPAGE=''
export CARGO_PKG_LICENSE=Apache-2.0
export CARGO_PKG_LICENSE_FILE=''
export CARGO_PKG_NAME=crewon-app-server
export CARGO_PKG_README=README.md
export CARGO_PKG_REPOSITORY=''
export CARGO_PKG_RUST_VERSION=''
export CARGO_PKG_VERSION=0.0.0
export CARGO_PKG_VERSION_MAJOR=0
export CARGO_PKG_VERSION_MINOR=0
export CARGO_PKG_VERSION_PATCH=0
export CARGO_PKG_VERSION_PRE=''
export CODEX_CI=1
export CODEX_INTERNAL_ORIGINATOR_OVERRIDE='Codex Desktop'
export CODEX_PERMISSION_PROFILE=:danger-full-access
export CODEX_SHELL=1
export CODEX_THREAD_ID=019f550e-ba52-7490-a248-b0d3a84103c1
export COLORTERM=''
export COMMAND_MODE=unix2003
export CONDA_DEFAULT_ENV=base
export CONDA_EXE=/opt/homebrew/Caskroom/miniconda/base/bin/conda
export CONDA_PREFIX=/opt/homebrew/Caskroom/miniconda/base
export CONDA_PROMPT_MODIFIER='(base) '
export CONDA_PYTHON_EXE=/opt/homebrew/Caskroom/miniconda/base/bin/python
export CONDA_SHLVL=1
export CREWON_APP_SERVER_DISABLE_MANAGED_CONFIG=1
export CREWON_HOME=/Users/wangqichen/projects/brilliant/cuican-aide/.crewon
export DISABLE_AUTO_UPDATE=true
export GH_PAGER=cat
export GIT_PAGER=cat
export HOME=/Users/wangqichen
export HOMEBREW_API_DOMAIN=https://mirrors.aliyun.com/homebrew/homebrew-bottles/api
export HOMEBREW_BOTTLE_DOMAIN=https://mirrors.aliyun.com/homebrew/homebrew-bottles
export HOMEBREW_CELLAR=/opt/homebrew/Cellar
export HOMEBREW_PIP_INDEX_URL=http://mirrors.aliyun.com/pypi/simple
export HOMEBREW_PREFIX=/opt/homebrew
export HOMEBREW_REPOSITORY=/opt/homebrew
export INFOPATH=/opt/homebrew/share/info:/opt/homebrew/share/info:/opt/homebrew/share/info:
export INIT_CWD=/Users/wangqichen/projects/brilliant/cuican-aide
export LANG=C.UTF-8
export LC_ALL=C.UTF-8
export LC_CTYPE=C.UTF-8
export LESS=-R
export LOGNAME=wangqichen
export LOG_FORMAT=json
export LSCOLORS=Gxfxcxdxbxegedabagacad
export LS_COLORS='di=1;36:ln=35:so=32:pi=33:ex=31:bd=34;46:cd=34;43:su=30;41:sg=30;46:tw=30;42:ow=30;43'
export MallocNanoZone=0
export NODE=/opt/homebrew/Cellar/node/23.11.0/bin/node
export NO_COLOR=1
export OPENAI_API_KEY=sk-9UG4A9PVJhIh0koX0CCE0eTeSo74kTLD38h9bde13uYM0BXN
export OSLogRateLimit=64
export PAGER=less
export PNPM_SCRIPT_SRC_DIR=/Users/wangqichen/projects/brilliant/cuican-aide
export PYENV_ROOT=/Users/wangqichen/.pyenv
export PYENV_SHELL=zsh
export RUSTUP_HOME=/Users/wangqichen/.rustup
export RUSTUP_TOOLCHAIN=stable-aarch64-apple-darwin
export RUSTUP_TOOLCHAIN_SOURCE=default
export RUST_LOG=warn
export RUST_RECURSION_COUNT=1
export SHELL=/bin/zsh
export SSH_AUTH_SOCK=/private/tmp/com.apple.launchd.1rtDM8zPhB/Listeners
export TERM=dumb
export TMPDIR=/var/folders/21/g7vtj67957zg65l1117cmgqr0000gn/T/
export USER=wangqichen
export XPC_FLAGS=0x0
export XPC_SERVICE_NAME=0
export ZSH=/Users/wangqichen/.oh-my-zsh
export ZSH_TMUX_AUTOSTART=false
export ZSH_TMUX_AUTOSTARTED=true
export __CFBundleIdentifier=com.openai.codex
export __CF_USER_TEXT_ENCODING=0x1F5:0x19:0x34
export npm_command=run-script
export npm_config__jsr_registry=https://npm.jsr.io/
export npm_config_block_exotic_subdeps=true
export npm_config_frozen_lockfile=''
export npm_config_globalconfig=/Users/wangqichen/Library/Preferences/pnpm/rc
export npm_config_manage_package_manager_versions=''
export npm_config_minimum_release_age=10080
export npm_config_node_gyp=/Users/wangqichen/Library/pnpm/.tools/pnpm/10.33.0_tmp_93374_0/node_modules/pnpm/dist/node_modules/node-gyp/bin/node-gyp.js
export npm_config_node_linker=hoisted
export npm_config_npm_globalconfig=/opt/homebrew/Cellar/node/23.11.0/etc/npmrc
export npm_config_prefer_workspace_packages=true
export npm_config_registry=https://registry.npmjs.org/
export npm_config_shamefully_hoist=true
export npm_config_strict_dep_builds=true
export npm_config_strict_peer_dependencies=''
export npm_config_trust_policy=no-downgrade
export npm_config_trust_policy_ignore_after=10080
export npm_config_user_agent='pnpm/10.33.0 npm/? node/v23.11.0 darwin arm64'
export npm_config_verify_deps_before_run=false
export npm_execpath=/Users/wangqichen/Library/pnpm/.tools/pnpm/10.33.0_tmp_93374_0/node_modules/pnpm/bin/pnpm.cjs
export npm_lifecycle_event=crewon:app-server
export npm_lifecycle_script='bash scripts/crewon-app-server.sh'
export npm_node_execpath=/opt/homebrew/Cellar/node/23.11.0/bin/node
export npm_package_engines_node='>=22'
export npm_package_engines_pnpm='>=10.33.0'
export npm_package_json=/Users/wangqichen/projects/brilliant/cuican-aide/package.json
export npm_package_name=crewon-monorepo
export pnpm_config_verify_deps_before_run=false
