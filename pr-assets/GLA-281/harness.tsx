import React from 'react';
import {createRoot} from 'react-dom/client';
import {MotionProvider} from './src/motion-provider';
import {Dialog,DialogTrigger,DialogContent,DialogTitle} from './src/components/dialog';
import {TooltipProvider,Tooltip,TooltipTrigger,TooltipContent} from './src/components/tooltip';
import {Popover,PopoverTrigger,PopoverContent} from './src/components/popover';
import {DropdownMenu,DropdownMenuTrigger,DropdownMenuContent,DropdownMenuItem} from './src/components/dropdown-menu';
import {ConfirmProvider,useConfirm} from './src/components/confirm-dialog';
import {ToastProvider,useToast} from './src/components/toast';
import './src/styles.css';
function Demo(){const [open,setOpen]=React.useState(false); React.useEffect(()=>{window.setDialogOpen=setOpen},[]);const confirm=useConfirm(); const {toast}=useToast();return <main style={{padding:60,display:'flex',gap:20}}>
<Dialog open={open} onOpenChange={setOpen}><DialogTrigger>Dialog</DialogTrigger><DialogContent aria-describedby={undefined}><DialogTitle>Workspace settings</DialogTitle><p>Changes remain yours to review.</p><button>Save</button></DialogContent></Dialog>
<button onClick={()=>confirm({title:'Remove workspace?',description:'This action cannot be undone.'})}>Confirm</button>
<TooltipProvider delayDuration={0} disableHoverableContent><Tooltip><TooltipTrigger>Tooltip</TooltipTrigger><TooltipContent>Workspace details</TooltipContent></Tooltip></TooltipProvider>
<Popover><PopoverTrigger>Popover</PopoverTrigger><PopoverContent>Workspace details<button>Inspect</button></PopoverContent></Popover>
<DropdownMenu><DropdownMenuTrigger>Menu</DropdownMenuTrigger><DropdownMenuContent><DropdownMenuItem>Inspect workspace</DropdownMenuItem><DropdownMenuItem>Settings</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
<button onClick={()=>toast('Workspace saved')}>Toast</button></main>}
createRoot(document.getElementById('root')!).render(<MotionProvider><ToastProvider><ConfirmProvider><Demo/></ConfirmProvider></ToastProvider></MotionProvider>);
